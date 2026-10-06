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
  #startPromise = null;
  #enginePath = null;
  #observerBound = false;

  constructor(enginePath = null) {
    if (enginePath) {
      this.#enginePath = enginePath;
    } else {
      try {
        this.#enginePath = Services.prefs.getStringPref("zen.voicenav.engine-path");
      } catch (_) {
        const envBin = Services.env?.get("ZEN_VOICE_ENGINE_BIN");
        if (envBin) {
          this.#enginePath = envBin;
        } else {
          this.#enginePath = PathUtils.join(PathUtils.profileDir, "zen-voice-engine.exe");
        }
      }
    }

    this.#registerShutdownObserver();
  }

  #registerShutdownObserver() {
    if (this.#observerBound) return;
    this.#observerBound = true;
    Services.obs.addObserver(this, "quit-application-granted");
  }

  observe(subject, topic, data) {
    if (topic === "quit-application-granted") {
      this.shutdown();
    }
  }

  /**
   * Inicia el subproceso zen-voice-engine si no está activo.
   * Utiliza una promesa única de arranque para evitar carreras y polling con timers.
   */
  async ensureStarted() {
    if (this.#process) return true;
    if (this.#startPromise) {
      return this.#startPromise;
    }

    this.#startPromise = this.#doStart();
    try {
      return await this.#startPromise;
    } finally {
      this.#startPromise = null;
    }
  }

  async #doStart() {
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
      return true;
    } catch (e) {
      console.warn("[ZenVoiceEngineClient] Subproceso de voz no disponible o falló al iniciar:", e?.message || e);
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

              // Si el botón está silenciado y no es orden de activación explícita, ignorar
              const isMuted = Services.zenVoiceNavButtonState === "muted";
              const isUnmuteIntent = /^(?:activar|reanudar|desmutear)\s+voz$/i.test(transcript.trim());
              if (isMuted && !isUnmuteIntent) {
                logDebug(`Comando ignorado: la navegación por voz está silenciada.`);
                continue;
              }

              // Notificar estado al botón de navegación
              if (typeof Services.zenSetVoiceState === "function") {
                Services.zenSetVoiceState("processing");
              }

              // Notificar al HUD nativo de la ventana activa
              const activeWin = Services.wm?.getMostRecentWindow("navigator:browser");
              if (activeWin && typeof Services.zenShowVoiceHUD === "function") {
                Services.zenShowVoiceHUD(activeWin, {
                  success: true,
                  transcript,
                  label: "Procesando voz...",
                });
              }
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
                    }).finally(() => {
                      if (typeof Services.zenSetVoiceState === "function") {
                        Services.zenSetVoiceState(Services.zenVoiceNavButtonState === "muted" ? "muted" : "listening");
                      }
                    });
                    dispatched = true;
                    break;
                  } else if (win.gZenVoiceNav) {
                    logDebug(`gZenVoiceNav encontrado en ventana #${count}. Despachando...`);
                    win.gZenVoiceNav.processCommand(transcript).catch((e) => {
                      logDebug(`Error en gZenVoiceNav.processCommand: ${e}`);
                    }).finally(() => {
                      if (typeof Services.zenSetVoiceState === "function") {
                        Services.zenSetVoiceState(Services.zenVoiceNavButtonState === "muted" ? "muted" : "listening");
                      }
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
   * Si el motor no está disponible o la preferencia mock está activa,
   * se utiliza un clasificador léxico in-process (Zero-Dependency fallback).
   * @param {string} transcript - Texto transcrito por voz.
   * @param {Array} candidates - Nodos AOM recolectados por ZenVoiceNavChild.
   * @param {number} topK - Cantidad de candidatos a podar.
   */
  async classify(transcript, candidates, topK = 10) {
    let forceMock = false;
    try {
      forceMock = Services.prefs.getBoolPref("zen.voicenav.mock-engine", false);
    } catch (_) {}

    if (forceMock) {
      logDebug("[ZenVoiceEngineClient] zen.voicenav.mock-engine activado. Usando clasificador in-process.");
      return this.#inProcessLexicalClassify(transcript, candidates, topK);
    }

    const started = await this.ensureStarted();
    if (!started) {
      logDebug("[ZenVoiceEngineClient] Subproceso de voz no disponible. Activando fallback léxico in-process.");
      return this.#inProcessLexicalClassify(transcript, candidates, topK);
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
   * Clasificador léxico ligero ejecutado en el Chrome Process sin dependencias binarias.
   * Permite a los maintainers de Zen Browser probar la suite completa de actores AOM
   * y navegación por voz sin necesidad de compilar o distribuir el demonio de Rust.
   */
  #inProcessLexicalClassify(transcript, candidates, topK = 10) {
    if (!transcript || !Array.isArray(candidates) || candidates.length === 0) {
      return {
        matched_id: null,
        action: null,
        confidence: 0,
        latency_ms: 0.05,
        tier: "tier1_in_process_fallback",
      };
    }

    const tNorm = transcript.toLowerCase().trim();
    const tWords = tNorm.split(/\s+/).filter(Boolean);

    let bestCandidate = null;
    let bestScore = 0;

    for (const cand of candidates) {
      const name = (cand.name || "").toLowerCase().trim();
      const desc = (cand.description || "").toLowerCase().trim();
      const targetText = `${name} ${desc}`.trim();

      if (!targetText) continue;

      let score = 0;

      // Coincidencia exacta de nombre o descripción
      if (name === tNorm) {
        score = 1.0;
      } else if (targetText.includes(tNorm) || tNorm.includes(name)) {
        score = 0.85;
      } else {
        // Coincidencia por conjunto de tokens
        let matchedWords = 0;
        for (const w of tWords) {
          if (w.length > 1 && targetText.includes(w)) {
            matchedWords++;
          }
        }
        if (matchedWords > 0) {
          score = (matchedWords / tWords.length) * 0.75;
        }
      }

      if (score > bestScore) {
        bestScore = score;
        bestCandidate = cand;
      }
    }

    const matched = bestScore >= 0.30 ? bestCandidate : null;
    return {
      matched_id: matched ? matched.id : null,
      action: matched ? (matched.name || matched.role || "click") : null,
      confidence: bestScore,
      latency_ms: 0.1,
      tier: "tier1_in_process_fallback",
    };
  }

  /**
   * Detiene el subproceso limpiamente.
   */
  async shutdown() {
    this.#cleanup();
  }

  #cleanup() {
    if (this.#observerBound) {
      try {
        Services.obs.removeObserver(this, "quit-application-granted");
      } catch (_) {}
      this.#observerBound = false;
    }
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
