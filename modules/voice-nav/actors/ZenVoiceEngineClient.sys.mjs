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

export class ZenVoiceEngineClient {
  #process = null;
  #pendingRequests = []; // Cola de resolvers { resolve, reject }
  #readBuffer = "";
  #isStarting = false;
  #enginePath = null;

  constructor(enginePath = null) {
    this.#enginePath =
      enginePath ||
      Services.prefs.getStringPref(
        "zen.voicenav.engine-path",
        PathUtils.join(PathUtils.profileDir, "zen-voice-engine.exe")
      );
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
      this.#process = await Subprocess.call({
        command: this.#enginePath,
        arguments: [],
        environment: {
          RUST_BACKTRACE: "1",
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
        const lines = this.#readBuffer.split("\n");
        // El último elemento puede ser un fragmento incompleto
        this.#readBuffer = lines.pop();

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          try {
            const parsed = JSON.parse(trimmed);
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
      this.#process.stdin.writeString(payload).catch((err) => {
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
