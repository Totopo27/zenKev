// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

/**
 * @file ZenVoiceEngineClient.sys.mjs
 * Cliente IPC del proceso principal (Chrome Process) que:
 * 1. Lanza el demonio nativo zen-voice-engine.exe como subproceso.
 * 2. Se comunica mediante Stdio NDJSON con bajo overhead.
 * 3. Encola peticiones con correlación de respuestas por cola asíncrona.
 * 4. Gestiona reconexión automática y apagado limpio (didDestroy/shutdown).
 */

const { Subprocess } = ChromeUtils.importESModule("resource://gre/modules/Subprocess.sys.mjs");

function logDebug(msg) {
  let isDebug = false;
  try {
    isDebug = Services.prefs.getBoolPref("zen.voicenav.debug", false);
  } catch (_) {}

  if (!isDebug) return;

  const time = new Date().toLocaleTimeString();
  const line = `[ZenKev:EngineClient ${time}] ${msg}`;
  console.log(line);

  try {
    if (typeof IOUtils !== "undefined" && IOUtils.writeUTF8 && PathUtils?.profileDir) {
      const logPath = PathUtils.join(PathUtils.profileDir, "zenkev_debug.log");
      IOUtils.writeUTF8(logPath, line + "\n", { mode: "appendOrCreate" }).catch(() => {});
    }
  } catch (_) {}
}

export class ZenVoiceEngineClient {
  #process = null;
  #pendingRequests = []; // Cola de resolvers { resolve, reject }
  #readBuffer = "";
  #isStarting = false;
  #enginePath = null;

  constructor(enginePath = null) {
    if (enginePath) {
      this.#enginePath = enginePath;
    } else {
      try {
        this.#enginePath = Services.prefs.getStringPref("zen.voicenav.engine-path");
      } catch (_) {
        this.#enginePath = PathUtils.join(PathUtils.profileDir, "zen-voice-engine.exe");
      }
    }
  }

  /**
   * Inicia el subproceso zen-voice-engine si no está activo.
   */
  async ensureStarted() {
    if (this.#process) return true;
    if (this.#isStarting) {
      while (this.#isStarting) {
        await new Promise((r) => setTimeout(r, 20));
      }
      return !!this.#process;
    }

    this.#isStarting = true;
    try {
      const ipcPath = Services.env.get("ZEN_VOICE_IPC_PATH") ||
                      PathUtils.join(PathUtils.tempDir, "zen_voice_command.ipc");

      this.#process = await Subprocess.call({
        command: this.#enginePath,
        arguments: ["--ipc", ipcPath],
        environment: {
          RUST_BACKTRACE: "1",
          ZEN_VOICE_IPC_PATH: ipcPath,
        },
        stderr: "stdout",
      });

      this.#startReadLoop();
      this.#isStarting = false;
      return true;
    } catch (e) {
      console.error("[ZenVoiceEngineClient] Error al arrancar subproceso del motor de voz:", e);
      this.#isStarting = false;
      this.#process = null;
      return false;
    }
  }

  /**
   * Bucle asíncrono de lectura de Stdio (NDJSON).
   */
  async #startReadLoop() {
    const stdout = this.#process.stdout;
    try {
      while (this.#process) {
        const chunk = await stdout.readString();
        if (!chunk) break;

        this.#readBuffer += chunk;
        if (this.#readBuffer.length > 1024 * 1024) {
          console.warn("[ZenVoiceEngineClient] #readBuffer excedió 1MB sin salto de línea. Truncando para prevenir DoS.");
          this.#readBuffer = "";
        }
        const lines = this.#readBuffer.split("\n");
        // El último elemento puede ser un fragmento incompleto
        this.#readBuffer = lines.pop();

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          try {
            const parsed = JSON.parse(trimmed);

            // Si es un comando de voz transcrito recibido en tiempo real por el motor
            if (parsed.voice_command || parsed.type === "transcription_ready") {
              const transcript = parsed.transcript || parsed.voice_command || parsed.text;
              logDebug(`Comando en vivo recibido: "${transcript}"`);
              try {
                const windows = Services.wm.getEnumerator("navigator:browser");
                let dispatched = false;
                let count = 0;
                while (windows.hasMoreElements()) {
                  count++;
                  const win = windows.getNext();
                  if (!win || win.closed) continue;

                  const browser = win.gBrowser?.selectedBrowser;
                  const uri = browser?.currentURI?.spec || "sin uri";
                  logDebug(`Ventana #${count} URL activa: ${uri}`);

                  const cwg = browser?.browsingContext?.currentWindowGlobal;
                  let actor = null;
                  try {
                    actor = cwg?.getActor("ZenVoiceNav");
                  } catch (errActor) {
                    logDebug(`Error al llamar getActor("ZenVoiceNav"): ${errActor}`);
                  }

                  if (actor) {
                    logDebug(`Actor ZenVoiceNav encontrado en ventana #${count}. Despachando processVoiceCommand...`);
                    actor.processVoiceCommand(transcript).catch((e) => {
                      logDebug(`Error en actor.processVoiceCommand: ${e}`);
                    });
                    dispatched = true;
                    break;
                  } else if (win.gZenVoiceNav) {
                    logDebug(`gZenVoiceNav encontrado en ventana #${count}. Despachando...`);
                    win.gZenVoiceNav.processCommand(transcript).catch((e) => {
                      logDebug(`Error en gZenVoiceNav.processCommand: ${e}`);
                    });
                    dispatched = true;
                    break;
                  } else {
                    logDebug(`Ventana #${count} NO tiene actor ni gZenVoiceNav`);
                  }
                }
                if (!dispatched) {
                  logDebug(`AVISO: Ninguna ventana/pestaña pudo procesar el comando.`);
                }
              } catch (e) {
                logDebug(`Excepción al despachar comando: ${e}`);
              }
              continue;
            }

            const nextResolver = this.#pendingRequests.shift();
            if (nextResolver) {
              nextResolver.resolve(parsed);
            }
          } catch (err) {
            console.warn("[ZenVoiceEngineClient] Mensaje no parseable desde el motor:", trimmed, err);
          }
        }
      }
    } catch (e) {
      console.error("[ZenVoiceEngineClient] Error en loop de lectura Stdio:", e);
    } finally {
      this.#cleanup();
    }
  }

  /**
   * Despacha una petición de clasificación hacia el motor de Rust.
   * @param {string} transcript - Texto transcrito por voz.
   * @param {Array} candidates - Nodos AOM recolectados por ZenVoiceNavChild.
   * @param {number} topK - Cantidad de candidatos a podar.
   */
  async classify(transcript, candidates, topK = 10) {
    const started = await this.ensureStarted();
    if (!started) {
      return { error: "Motor de voz no disponible" };
    }

    const payload = JSON.stringify({
      transcript,
      candidates,
      top_k: topK,
    }) + "\n";

    return new Promise((resolve, reject) => {
      this.#pendingRequests.push({ resolve, reject });
      this.#process.stdin.write(payload).catch((err) => {
        // Remover de la cola si falló la escritura
        const idx = this.#pendingRequests.findIndex((r) => r.resolve === resolve);
        if (idx !== -1) this.#pendingRequests.splice(idx, 1);
        reject(err);
      });
    });
  }

  /**
   * Detiene el subproceso limpiamente.
   */
  async shutdown() {
    this.#cleanup();
  }

  #cleanup() {
    if (this.#process) {
      try {
        this.#process.kill();
      } catch (_) {}
      this.#process = null;
    }
    // Rechazar peticiones pendientes
    while (this.#pendingRequests.length > 0) {
      const { reject } = this.#pendingRequests.shift();
      reject(new Error("Motor de voz detenido"));
    }
    this.#readBuffer = "";
  }
}
