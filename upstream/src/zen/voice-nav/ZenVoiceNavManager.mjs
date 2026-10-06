// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

/* eslint-disable consistent-return */

import { nsZenDOMOperatedFeature } from "chrome://browser/content/zen-components/ZenCommonUtils.mjs";

const PREF_ENABLED = "zen.voicenav.enabled";
const PREF_MODE = "zen.voicenav.mode";

/**
 * Manages the Zen Voice Navigator feature in the browser chrome window.
 * Provides hotkey handling, HUD feedback, and bridges to the ZenVoiceNav JSWindowActor.
 */
class nsZenVoiceNavManager extends nsZenDOMOperatedFeature {
  #initialized = false;
  #hudElement = null;
  #hudTimer = null;

  init() {
    if (this.#initialized) return;
    this.#initialized = true;

    this.registerPrefListener(PREF_ENABLED, this.#onPrefChanged.bind(this));
    this.#onPrefChanged();
  }

  get isEnabled() {
    try {
      return Services.prefs.getBoolPref(PREF_ENABLED, false);
    } catch (_) {
      return false;
    }
  }

  get currentMode() {
    try {
      return Services.prefs.getStringPref(PREF_MODE, "visual-overlay");
    } catch (_) {
      return "visual-overlay";
    }
  }

  #onPrefChanged() {
    if (this.isEnabled) {
      this.#setupShortcuts();
    } else {
      this.#teardownShortcuts();
      this.hideHUD();
    }
  }

  #setupShortcuts() {
    window.addEventListener("keydown", this.#handleKeydown, true);
  }

  #teardownShortcuts() {
    window.removeEventListener("keydown", this.#handleKeydown, true);
  }

  #handleKeydown = (event) => {
    // Ctrl+Shift+V or Cmd+Shift+V triggers voice overlay / listening
    if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.code === "KeyV") {
      event.preventDefault();
      event.stopPropagation();
      this.toggleOverlay();
    }
  };

  /**
   * Retrieves the ZenVoiceNav actor for the currently selected browser tab.
   */
  getActiveActor() {
    const browser = window.gBrowser?.selectedBrowser;
    const cwg = browser?.browsingContext?.currentWindowGlobal;
    if (!cwg) return null;

    try {
      return cwg.getActor("ZenVoiceNav");
    } catch (e) {
      console.warn("[nsZenVoiceNavManager] ZenVoiceNav actor not registered or available:", e);
      return null;
    }
  }

  /**
   * Toggles the interactive visual overlay badges on the active web page.
   */
  async toggleOverlay() {
    if (!this.isEnabled) return;

    const actor = this.getActiveActor();
    if (!actor) return;

    try {
      const candidates = await actor.getCandidates(true);
      if (candidates?.candidates?.length > 0) {
        await actor.showVisualOverlay(candidates.candidates);
        this.showHUD({
          label: `${candidates.candidates.length} elementos detectados`,
          success: true,
        });
      } else {
        this.showHUD({
          label: "Sin elementos interactivos visibles",
          success: false,
        });
      }
    } catch (e) {
      console.error("[nsZenVoiceNavManager] Error toggling overlay:", e);
    }
  }

  /**
   * Dispatches a text transcript or command to the active actor.
   */
  async processCommand(transcript) {
    if (!this.isEnabled || !transcript) return;

    const actor = this.getActiveActor();
    if (!actor) {
      this.showHUD({ label: "Navegador no listo", success: false });
      return;
    }

    this.showHUD({ label: `Procesando: "${transcript}"`, success: true });
    try {
      const result = await actor.processVoiceCommand(transcript);
      if (result?.success) {
        this.showHUD({
          label: `Ejecutado: ${result.action || "Completado"}`,
          success: true,
        });
      } else {
        this.showHUD({
          label: result?.reason || "Comando no reconocido",
          success: false,
        });
      }
      return result;
    } catch (e) {
      console.error("[nsZenVoiceNavManager] Error processing command:", e);
      this.showHUD({ label: "Error interno al ejecutar", success: false });
    }
  }

  /**
   * Displays non-blocking, accessible feedback in the chrome window.
   */
  showHUD({ label, success = true, durationMs = 2400 }) {
    if (!this.#hudElement) {
      this.#hudElement = document.createElement("div");
      this.#hudElement.id = "zen-voice-nav-hud";
      document.documentElement.appendChild(this.#hudElement);
    }

    this.#hudElement.textContent = label;
    this.#hudElement.classList.add("active");

    if (this.#hudTimer) {
      window.clearTimeout(this.#hudTimer);
    }

    this.#hudTimer = window.setTimeout(() => {
      this.hideHUD();
    }, durationMs);
  }

  hideHUD() {
    if (this.#hudElement) {
      this.#hudElement.classList.remove("active");
    }
    if (this.#hudTimer) {
      window.clearTimeout(this.#hudTimer);
      this.#hudTimer = null;
    }
  }
}

window.gZenVoiceNavManager = new nsZenVoiceNavManager();
