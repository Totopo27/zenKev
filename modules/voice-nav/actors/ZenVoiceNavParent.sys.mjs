// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

/**
 * @file ZenVoiceNavParent.sys.mjs
 * Módulo del proceso principal (Chrome / Parent Process) que:
 * 1. Dialoga con el Actor Child a través de JSWindowActorParent.
 * 2. Solicita la lista podada de candidatos AOM de la pestaña seleccionada.
 * 3. Expone la API para ejecutar acciones en el nodo seleccionado.
 * 4. Actúa de puente hacia el demonio Rust (IPC / Native Messaging vía Subprocess).
 */

import { ZenVoiceEngineClient } from "resource:///actors/ZenVoiceEngineClient.sys.mjs";

function logDebug(msg) {
  let isDebug = false;
  try {
    isDebug = Services.prefs.getBoolPref("zen.voicenav.debug", false);
  } catch (_) {}

  if (!isDebug) return;

  const time = new Date().toLocaleTimeString();
  const line = `[ZenKev:Parent ${time}] ${msg}`;
  console.log(line);

  try {
    if (typeof IOUtils !== "undefined" && IOUtils.writeUTF8 && PathUtils?.profileDir) {
      const logPath = PathUtils.join(PathUtils.profileDir, "zenkev_debug.log");
      IOUtils.writeUTF8(logPath, line + "\n", { mode: "appendOrCreate" }).catch(() => {});
    }
  } catch (_) {}
}

let gVoiceEngineClient = null;

function getVoiceEngineClient() {
  if (!gVoiceEngineClient) {
    gVoiceEngineClient = new ZenVoiceEngineClient();
    gVoiceEngineClient.ensureStarted().catch((err) => {
      console.warn("[ZenVoiceNavParent] No se pudo auto-iniciar el motor de voz:", err);
    });
  }
  return gVoiceEngineClient;
}

function getVoiceNavMode(overrideMode = null) {
  if (overrideMode) return overrideMode;
  try {
    return Services.prefs.getStringPref("zen.voicenav.mode");
  } catch (_) {
    return "both";
  }
}

export function initZenVoiceNav(topWin) {
  if (!topWin || topWin.gZenVoiceNav) return;
  topWin.gZenVoiceNav = {
    getActor: () => topWin.gBrowser?.selectedBrowser?.browsingContext?.currentWindowGlobal?.getActor("ZenVoiceNav"),
    getCandidates: async (onlyVisible = true) => {
      const actor = topWin.gBrowser?.selectedBrowser?.browsingContext?.currentWindowGlobal?.getActor("ZenVoiceNav");
      return actor ? await actor.getCandidates(onlyVisible) : { candidates: [], error: "No actor" };
    },
    showOverlay: async () => {
      const actor = topWin.gBrowser?.selectedBrowser?.browsingContext?.currentWindowGlobal?.getActor("ZenVoiceNav");
      if (!actor) return { success: false, error: "No actor" };
      const r = await actor.getCandidates(true);
      return await actor.showVisualOverlay(r.candidates || []);
    },
    hideOverlay: async () => {
      const actor = topWin.gBrowser?.selectedBrowser?.browsingContext?.currentWindowGlobal?.getActor("ZenVoiceNav");
      return actor ? await actor.hideVisualOverlay() : { success: false };
    },
    processCommand: async (transcript) => {
      const actor = topWin.gBrowser?.selectedBrowser?.browsingContext?.currentWindowGlobal?.getActor("ZenVoiceNav");
      return actor ? await actor.processVoiceCommand(transcript) : { success: false, error: "No actor" };
    },
    toggleOverlay: async () => {
      const actor = topWin.gBrowser?.selectedBrowser?.browsingContext?.currentWindowGlobal?.getActor("ZenVoiceNav");
      if (!actor) return;
      if (topWin._zenVoiceNavOverlayActive) {
        topWin._zenVoiceNavOverlayActive = false;
        await actor.hideVisualOverlay();
      } else {
        topWin._zenVoiceNavOverlayActive = true;
        const r = await actor.getCandidates(true);
        await actor.showVisualOverlay(r.candidates || []);
      }
    }
  };

  topWin.addEventListener("keydown", (e) => {
    // Atajos no conflictivos con Zen Browser ni Windows:
    // 1. F2 (tecla única rápida)
    // 2. Ctrl + Shift + Espacio (estilo asistente manos libres)
    // 3. Alt + Shift + V (Voice)
    const isF2 = e.key === "F2";
    const isCtrlShiftSpace = e.ctrlKey && e.shiftKey && (e.key === " " || e.code === "Space");
    const isAltShiftV = e.altKey && e.shiftKey && e.key.toLowerCase() === "v";

    if (isF2 || isCtrlShiftSpace || isAltShiftV) {
      e.preventDefault();
      e.stopPropagation();
      topWin.gZenVoiceNav.toggleOverlay();
    }
  }, { capture: true });

  console.log("[ZenKev] Inicializado con éxito. Alternar capa visual con F2, Ctrl+Shift+Espacio o Alt+Shift+V.");
  getVoiceEngineClient();
}

export class ZenVoiceNavParent extends JSWindowActorParent {
  constructor() {
    super();
    try {
      const topWin = this.browsingContext?.topChromeWindow;
      if (topWin) {
        initZenVoiceNav(topWin);
      }
    } catch (_) {}
  }

  /**
   * Obtiene los candidatos interactivos de la pestaña actual.
   * @param {boolean} onlyVisible - Si es true, poda elementos fuera del viewport.
   */
  async getCandidates(onlyVisible = true) {
    try {
      return await this.sendQuery("ZenVoiceNav:GetCandidates", { onlyVisible });
    } catch (e) {
      console.error("[ZenVoiceNavParent] Error al obtener candidatos AOM:", e);
      return { candidates: [], error: e.message };
    }
  }

  /**
   * Ejecuta la acción por defecto sobre un nodo accesible identificado por ID.
   * @param {string|number} targetId - uniqueID del nodo accesible.
   * @param {number} actionIndex - Índice de acción (0 para doDefaultAction).
   * @param {string} mode - "screen-reader" | "visual-overlay" | "both"
   */
  async executeAction(targetId, actionIndex = 0, mode = null) {
    const resolvedMode = getVoiceNavMode(mode);
    try {
      return await this.sendQuery("ZenVoiceNav:ExecuteAction", {
        targetId: String(targetId),
        actionIndex,
        mode: resolvedMode,
      });
    } catch (e) {
      console.error(`[ZenVoiceNavParent] Error al ejecutar acción en nodo ${targetId}:`, e);
      return { success: false, error: e.message };
    }
  }

  /**
   * Limpia el caché de nodos AOM retenidos en el Content Process.
   */
  async clearCache() {
    try {
      return await this.sendQuery("ZenVoiceNav:ClearCache");
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  /**
   * Solicita el recorte gráfico (128x128) de un nodo para inspección multimodal (Sistema 2).
   * @param {string|number} targetId - uniqueID del nodo accesible.
   */
  async captureNodeCrop(targetId) {
    try {
      return await this.sendQuery("ZenVoiceNav:CaptureNodeCrop", {
        targetId: String(targetId),
      });
    } catch (e) {
      console.error(`[ZenVoiceNavParent] Error al capturar recorte del nodo ${targetId}:`, e);
      return { success: false, error: e.message };
    }
  }

  /**
   * Muestra badges/etiquetas visuales en la página (Variante Videntes).
   * @param {Array} candidates - Lista de candidatos interactivos.
   */
  async showVisualOverlay(candidates = []) {
    try {
      return await this.sendQuery("ZenVoiceNav:ShowVisualOverlay", { candidates });
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  /**
   * Oculta el overlay visual de badges.
   */
  async hideVisualOverlay() {
    try {
      return await this.sendQuery("ZenVoiceNav:HideVisualOverlay");
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  /**
   * Procesa un comando de voz completo:
   * 1. Extrae candidatos AOM podados del Child.
   * 2. Si está en modo vidente, muestra el overlay con badges.
   * 3. Despacha al demonio Rust para clasificar en <1ms.
   * 4. Ejecuta la acción en el nodo ganador con la variante sensorial configurada.
   * @param {string} transcript - Texto del comando de voz.
   */
  async processVoiceCommand(transcript) {
    const mode = getVoiceNavMode();
    logDebug(`Iniciando processVoiceCommand: "${transcript}", modo: ${mode}`);

    // 1. Obtener candidatos interactivos
    let candidates = [];
    try {
      const candidatesRes = await this.getCandidates(true);
      candidates = candidatesRes?.candidates || [];
      logDebug(`getCandidates retornó ${candidates.length} elementos`);
    } catch (e) {
      logDebug(`Error en getCandidates: ${e}`);
    }

    if (candidates.length === 0) {
      logDebug(`Sin candidatos en pantalla. Abortando.`);
      try {
        this.sendAsyncMessage("ZenVoiceNav:LogCommand", {
          transcript,
          success: false,
          reason: "No hay elementos interactivos en pantalla",
        });
      } catch (_) {}
      return { success: false, reason: "No hay elementos accionables en pantalla" };
    }

    // 2. Si es modo visual, pintar los badges flotantes
    if (mode === "visual-overlay" || mode === "both") {
      await this.showVisualOverlay(candidates);
    }

    // 3. Consultar al motor en Rust
    logDebug(`Consultando clasificación al motor Rust...`);
    const engine = getVoiceEngineClient();
    const decision = await engine.classify(transcript, candidates, 10);
    logDebug(`Decisión de Rust: matched_id=${decision.matched_id}, action=${decision.action}, conf=${decision.confidence}`);

    // Notificar al Child para mostrar feedback visual (HUD + log de página)
    try {
      this.sendAsyncMessage("ZenVoiceNav:LogCommand", {
        transcript,
        success: !!decision.matched_id,
        decision,
      });
    } catch (_) {}

    // 4. Si requiere fallback a Sistema 2 (botón mudo), capturar recorte
    if (decision.fallback_to_vlm && decision.matched_id) {
      console.log("[ZenVoiceNavParent] Activando Sistema 2 para botón mudo ID:", decision.matched_id);
      const crop = await this.captureNodeCrop(decision.matched_id);
    }

    // 5. Ejecutar la acción si hubo un match con confianza suficiente
    if (decision.matched_id) {
      logDebug(`Ejecutando acción en nodo ID ${decision.matched_id}...`);
      const actionResult = await this.executeAction(decision.matched_id, 0, mode);
      logDebug(`Resultado de executeAction: ${JSON.stringify(actionResult)}`);
      return {
        success: true,
        matchedId: decision.matched_id,
        action: decision.action,
        confidence: decision.confidence,
        latencyMs: decision.latency_ms,
        actionResult,
      };
    }

    logDebug(`No se identificó acción con confianza suficiente.`);
    return {
      success: false,
      reason: "No se identificó una acción con suficiente confianza",
      decision,
    };
  }

  /**
   * Fuerza el foco accesible en el nodo objetivo.
   * @param {string|number} targetId - uniqueID del nodo accesible.
   * @param {string} mode - "screen-reader" | "visual-overlay" | "both"
   */
  async focusTarget(targetId, mode = null) {
    const resolvedMode = getVoiceNavMode(mode);
    try {
      return await this.sendQuery("ZenVoiceNav:FocusTarget", {
        targetId: String(targetId),
        mode: resolvedMode,
      });
    } catch (e) {
      console.error(`[ZenVoiceNavParent] Error al enfocar nodo ${targetId}:`, e);
      return { success: false, error: e.message };
    }
  }

  receiveMessage(message) {
    if (message.name === "ZenVoiceNav:Init") {
      getVoiceEngineClient();
      return { ok: true };
    }
  }
}

try {
  if (typeof window !== "undefined" && window.document) {
    initZenVoiceNav(window);
  }
} catch (_) {}
