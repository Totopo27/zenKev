// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

/**
 * @file ZenVoiceHUD.sys.mjs
 * Módulo profundo de presentación y feedback sensorial (visual y auditivo):
 * 1. HUD flotante nativo a nivel de ventana Chrome (cero colisiones de z-index o iframes).
 * 2. Indicadores vectoriales SVG de estado (escuchando, procesando, silenciado).
 * 3. Actualización de estado en el botón de la barra de herramientas de Zen Browser.
 * 4. Reproducción desacoplada de Earcons acústicos con fallback progresivo.
 */

import {
  EARCON_ERROR_URI,
  EARCON_MUTE_URI,
  EARCON_SUCCESS_URI,
  EARCON_UNMUTE_URI,
} from "./ZenVoiceEarconsData.sys.mjs";

function logDebug(msg) {
  let isDebug = false;
  try {
    isDebug = Services.prefs.getBoolPref("zen.voicenav.debug", false);
  } catch (_) {}

  if (!isDebug) return;

  const time = new Date().toLocaleTimeString();
  const line = `[ZenKev:HUD ${time}] ${msg}`;
  console.log(line);
}

/**
 * Reproduce un earcon acústico para confirmación no visual.
 */
export function playEarcon(type = "success", topWin = null) {
  try {
    const win = topWin || Services.wm?.getMostRecentWindow("navigator:browser");
    if (!win) return;

    let earconsEnabled = true;
    try {
      earconsEnabled = Services.prefs.getBoolPref("zen.voicenav.earcons", true);
    } catch (_) {}
    if (!earconsEnabled) return;

    let soundUri = null;
    if (type === "unmute") soundUri = EARCON_UNMUTE_URI;
    else if (type === "mute") soundUri = EARCON_MUTE_URI;
    else if (type === "success") soundUri = EARCON_SUCCESS_URI;
    else if (type === "error" || type === "unrecognized") soundUri = EARCON_ERROR_URI;

    if (soundUri && win.Audio) {
      const audio = new win.Audio(soundUri);
      audio.volume = 0.4;
      audio.play().catch(() => {});
      return;
    }

    try {
      if (Cc && Ci?.nsISound) {
        const sound = Cc["@mozilla.org/sound;1"]?.createInstance(Ci.nsISound);
        if (sound) {
          sound.beep();
          return;
        }
      }
    } catch (_) {}

    const AudioContextClass = win.AudioContext || win.webkitAudioContext;
    if (!AudioContextClass) {
      Services.beep?.();
      return;
    }

    if (!win._zenVoiceAudioCtx || win._zenVoiceAudioCtx.state === "closed") {
      win._zenVoiceAudioCtx = new AudioContextClass();
    }
    const ctx = win._zenVoiceAudioCtx;
    if (ctx.state === "suspended") {
      ctx.resume().catch(() => {});
    }

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);

    if (type === "success") {
      osc.frequency.setValueAtTime(587.33, ctx.currentTime);
      osc.frequency.setValueAtTime(880.0, ctx.currentTime + 0.08);
      gain.gain.setValueAtTime(0.08, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.22);
      osc.start();
      osc.stop(ctx.currentTime + 0.22);
    } else {
      osc.frequency.setValueAtTime(320.0, ctx.currentTime);
      osc.frequency.setValueAtTime(220.0, ctx.currentTime + 0.09);
      gain.gain.setValueAtTime(0.09, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.25);
      osc.start();
      osc.stop(ctx.currentTime + 0.25);
    }
  } catch (_) {}
}

export class ZenVoiceHUD {
  /**
   * Renderiza el HUD flotante nativo en la ventana del navegador.
   */
  static show(topWin, { success = true, transcript = "", label = "", latencyMs = null, tier = "tier1_lexical" } = {}) {
    const win = topWin || Services.wm?.getMostRecentWindow("navigator:browser");
    if (!win || !win.document) return;

    const doc = win.document;
    let hud = doc.getElementById("zenkev-native-chrome-hud");
    if (!hud) {
      hud = doc.createElementNS("http://www.w3.org/1999/xhtml", "div");
      hud.id = "zenkev-native-chrome-hud";
      hud.style.cssText = `
        position: fixed;
        top: 14px;
        left: 50%;
        transform: translateX(-50%) translateY(-14px);
        z-index: 2147483647;
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 7px 18px;
        border-radius: 9999px;
        background: rgba(15, 23, 42, 0.85);
        backdrop-filter: blur(20px) saturate(180%);
        -webkit-backdrop-filter: blur(20px) saturate(180%);
        border: 1px solid rgba(255, 255, 255, 0.12);
        box-shadow: 0 14px 34px rgba(0, 0, 0, 0.45);
        color: #f8fafc;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, system-ui, sans-serif;
        font-size: 13px;
        font-weight: 500;
        opacity: 0;
        pointer-events: none;
        transition: opacity 0.24s cubic-bezier(0.16, 1, 0.3, 1), transform 0.24s cubic-bezier(0.16, 1, 0.3, 1), border-color 0.24s ease, box-shadow 0.24s ease;
      `;

      const parentContainer = doc.getElementById("browser") || doc.documentElement;
      parentContainer.appendChild(hud);
    }

    hud.textContent = "";

    const glowColor = success ? "rgba(16, 185, 129, 0.4)" : "rgba(245, 158, 11, 0.4)";
    hud.style.borderColor = glowColor;
    hud.style.boxShadow = `0 14px 34px rgba(0, 0, 0, 0.45), 0 0 16px ${glowColor}`;

    const iconGem = doc.createElementNS("http://www.w3.org/1999/xhtml", "div");
    iconGem.style.cssText = `
      width: 24px;
      height: 24px;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      background: ${success ? "rgba(52, 211, 153, 0.16)" : "rgba(251, 191, 36, 0.16)"};
      border: 1px solid ${success ? "rgba(52, 211, 153, 0.3)" : "rgba(251, 191, 36, 0.3)"};
    `;

    const svgNS = "http://www.w3.org/2000/svg";
    const iconSvg = doc.createElementNS(svgNS, "svg");
    iconSvg.setAttribute("width", "13");
    iconSvg.setAttribute("height", "13");
    iconSvg.setAttribute("viewBox", "0 0 24 24");
    iconSvg.setAttribute("fill", "none");
    iconSvg.setAttribute("stroke", success ? "#34d399" : "#fbbf24");
    iconSvg.setAttribute("stroke-width", "2.2");
    iconSvg.setAttribute("stroke-linecap", "round");
    iconSvg.setAttribute("stroke-linejoin", "round");

    if (success) {
      const p1 = doc.createElementNS(svgNS, "path");
      p1.setAttribute("d", "M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z");
      const p2 = doc.createElementNS(svgNS, "path");
      p2.setAttribute("d", "M19 10v2a7 7 0 0 1-14 0v-2");
      const l1 = doc.createElementNS(svgNS, "line");
      l1.setAttribute("x1", "12");
      l1.setAttribute("y1", "19");
      l1.setAttribute("x2", "12");
      l1.setAttribute("y2", "22");
      iconSvg.appendChild(p1);
      iconSvg.appendChild(p2);
      iconSvg.appendChild(l1);
    } else {
      const p = doc.createElementNS(svgNS, "path");
      p.setAttribute("d", "m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z");
      const l1 = doc.createElementNS(svgNS, "line");
      l1.setAttribute("x1", "12");
      l1.setAttribute("y1", "9");
      l1.setAttribute("x2", "12");
      l1.setAttribute("y2", "13");
      const l2 = doc.createElementNS(svgNS, "line");
      l2.setAttribute("x1", "12");
      l2.setAttribute("y1", "17");
      l2.setAttribute("x2", "12.01");
      l2.setAttribute("y2", "17");
      iconSvg.appendChild(p);
      iconSvg.appendChild(l1);
      iconSvg.appendChild(l2);
    }
    iconGem.appendChild(iconSvg);
    hud.appendChild(iconGem);

    const textCol = doc.createElementNS("http://www.w3.org/1999/xhtml", "div");
    textCol.style.cssText = "display: flex; flex-direction: column; line-height: 1.25;";

    const titleRow = doc.createElementNS("http://www.w3.org/1999/xhtml", "div");
    titleRow.style.cssText = "font-weight: 600; color: #ffffff; white-space: nowrap;";
    titleRow.textContent = transcript ? `"${transcript}"` : (label || "Comando procesado");
    textCol.appendChild(titleRow);

    if (label) {
      const detailRow = doc.createElementNS("http://www.w3.org/1999/xhtml", "div");
      detailRow.style.cssText = `font-size: 11px; color: ${success ? "#34d399" : "#fbbf24"}; white-space: nowrap;`;
      const latencyStr = latencyMs != null ? ` (${latencyMs.toFixed(1)}ms)` : "";
      detailRow.textContent = `${label}${latencyStr}`;
      textCol.appendChild(detailRow);
    }

    hud.appendChild(textCol);

    hud.style.opacity = "1";
    hud.style.transform = "translateX(-50%) translateY(0)";

    playEarcon(success ? "success" : "error", win);

    if (win._zenkevChromeHudAnim) {
      try { win._zenkevChromeHudAnim.cancel(); } catch (_) {}
    }
    const isDemo = Services.prefs?.getBoolPref("zen.voicenav.demo_mode", false) || false;
    const displayDuration = isDemo ? 3800 : 2200;

    try {
      win._zenkevChromeHudAnim = hud.animate(
        [
          { opacity: 1, transform: "translateX(-50%) translateY(0)", offset: 0 },
          { opacity: 1, transform: "translateX(-50%) translateY(0)", offset: 0.85 },
          { opacity: 0, transform: "translateX(-50%) translateY(-14px)", offset: 1 }
        ],
        { duration: displayDuration, fill: "forwards" }
      );
      win._zenkevChromeHudAnim.finished.then(() => {
        hud.style.opacity = "0";
        hud.style.transform = "translateX(-50%) translateY(-14px)";
      }).catch(() => {});
    } catch (_) {
      hud.style.opacity = "0";
    }
  }

  /**
   * Genera el icono SVG data URI para el botón de voz según su estado.
   * @param {"listening" | "muted" | "processing"} state
   */
  static getButtonIcon(state = "listening") {
    let strokeColor = "#10b981";
    let centerFill = "#10b981";
    let pulseElement = `<circle cx="12" cy="8" r="2" fill="${centerFill}"/>`;

    if (state === "muted") {
      strokeColor = "#94a3b8";
      pulseElement = `<line x1="4" y1="4" x2="20" y2="20" stroke="#ef4444" stroke-width="2.5" stroke-linecap="round"/>`;
    } else if (state === "processing") {
      strokeColor = "#c084fc";
      centerFill = "#a855f7";
      pulseElement = `<circle cx="12" cy="8" r="2.5" fill="${centerFill}"><animate attributeName="opacity" values="0.3;1;0.3" dur="0.9s" repeatCount="indefinite"/></circle>`;
    }

    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="${strokeColor}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/>
    <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
    <line x1="12" x2="12" y1="19" y2="22"/>
    ${pulseElement}
  </svg>`;

    return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
  }

  /**
   * Actualiza visualmente el estado del botón en todas las ventanas activas.
   * @param {"listening" | "muted" | "processing"} state
   */
  static updateButtonState(state) {
    const prevState = Services.zenVoiceNavButtonState;
    Services.zenVoiceNavButtonState = state;

    if (state === "muted" && prevState !== "muted") {
      playEarcon("mute");
    } else if (state === "listening" && prevState === "muted") {
      playEarcon("unmute");
    }

    const iconUri = ZenVoiceHUD.getButtonIcon(state);

    try {
      const windows = Services.wm?.getEnumerator("navigator:browser");
      if (!windows) return;

      while (windows.hasMoreElements()) {
        const win = windows.getNext();
        if (!win || win.closed) continue;

        const btn = win.document?.getElementById("zen-voicenav-button");
        if (!btn) continue;

        btn.setAttribute("image", iconUri);
        const icon = btn.querySelector(".toolbarbutton-icon");
        if (icon) {
          icon.setAttribute("src", iconUri);
        }

        if (state === "listening") {
          btn.setAttribute(
            "tooltiptext",
            "Zen Voice Navigator: Escuchando (Clic: alternar overlay [F2] | Shift+Clic: silenciar)"
          );
          btn.style.filter = "drop-shadow(0 0 3px rgba(16, 185, 129, 0.45))";
        } else if (state === "muted") {
          btn.setAttribute(
            "tooltiptext",
            "Zen Voice Navigator: Silenciado (Clic: alternar overlay [F2] | Shift+Clic: activar)"
          );
          btn.style.filter = "none";
        } else if (state === "processing") {
          btn.setAttribute("tooltiptext", "Zen Voice Navigator: Procesando comando...");
          btn.style.filter = "drop-shadow(0 0 4px rgba(168, 85, 247, 0.6))";
        }
      }
    } catch (_) {}
  }
}

export const showNativeChromeHUD = ZenVoiceHUD.show;
export const updateVoiceNavButtonState = ZenVoiceHUD.updateButtonState;
export const getVoiceNavButtonIcon = ZenVoiceHUD.getButtonIcon;

// Enlazar Services globales
try {
  if (typeof Services !== "undefined") {
    Services.zenShowVoiceHUD = showNativeChromeHUD;
    Services.zenSetVoiceState = updateVoiceNavButtonState;
  }
} catch (_) {}
