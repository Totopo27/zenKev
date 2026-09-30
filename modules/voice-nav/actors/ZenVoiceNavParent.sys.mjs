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

let gVoiceEngineClient = null;

function getVoiceEngineClient() {
  if (!gVoiceEngineClient) {
    gVoiceEngineClient = new ZenVoiceEngineClient();
  }
  return gVoiceEngineClient;
}

export class ZenVoiceNavParent extends JSWindowActorParent {
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
    const resolvedMode = mode || Services.prefs.getStringPref("zen.voicenav.mode", "screen-reader");
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
    const mode = Services.prefs.getStringPref("zen.voicenav.mode", "screen-reader");

    // 1. Obtener candidatos interactivos
    const candidatesRes = await this.getCandidates(true);
    const candidates = candidatesRes.candidates || [];

    if (candidates.length === 0) {
      return { success: false, reason: "No hay elementos accionables en pantalla" };
    }

    // 2. Si es modo visual, pintar los badges flotantes
    if (mode === "visual-overlay" || mode === "both") {
      await this.showVisualOverlay(candidates);
    }

    // 3. Consultar al motor en Rust
    const engine = getVoiceEngineClient();
    const decision = await engine.classify(transcript, candidates, 10);

    // 4. Si requiere fallback a Sistema 2 (botón mudo), capturar recorte
    if (decision.fallback_to_vlm && decision.matched_id) {
      console.log("[ZenVoiceNavParent] Activando Sistema 2 para botón mudo ID:", decision.matched_id);
      const crop = await this.captureNodeCrop(decision.matched_id);
      // Aquí se enviaría el crop al vlm_engine si no estuviese resuelto por S1
    }

    // 5. Ejecutar la acción si hubo un match con confianza suficiente
    if (decision.matched_id) {
      const actionResult = await this.executeAction(decision.matched_id, 0, mode);
      return {
        success: true,
        matchedId: decision.matched_id,
        action: decision.action,
        confidence: decision.confidence,
        latencyMs: decision.latency_ms,
        actionResult,
      };
    }

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
    const resolvedMode = mode || Services.prefs.getStringPref("zen.voicenav.mode", "screen-reader");
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
}
