// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

/**
 * @file ZenVoiceNavParent.sys.mjs
 * Módulo del proceso principal (Chrome / Parent Process) que:
 * 1. Dialoga con el Actor Child a través de JSWindowActorParent.
 * 2. Ejecuta comandos globales de navegador (historial, pestañas, scroll, búsqueda, URLs).
 * 3. Solicita la lista podada de candidatos AOM de la pestaña seleccionada.
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

function getVoiceEngineClient() {
  if (!Services.zenVoiceEngineClient) {
    Services.zenVoiceEngineClient = new ZenVoiceEngineClient();
    Services.zenVoiceEngineClient.ensureStarted().catch((err) => {
      console.warn("[ZenVoiceNavParent] No se pudo auto-iniciar el motor de voz:", err);
    });
  }
  return Services.zenVoiceEngineClient;
}

function getVoiceNavMode(overrideMode = null) {
  if (overrideMode) return overrideMode;
  try {
    return Services.prefs.getStringPref("zen.voicenav.mode");
  } catch (_) {
    return "both";
  }
}

let _PlacesUtils = null;
function getPlacesUtils() {
  if (!_PlacesUtils) {
    try {
      _PlacesUtils = ChromeUtils.importESModule("resource://gre/modules/PlacesUtils.sys.mjs").PlacesUtils;
    } catch (_) {
      try {
        _PlacesUtils = Services.wm?.getMostRecentWindow("navigator:browser")?.PlacesUtils;
      } catch (_) {}
    }
  }
  return _PlacesUtils;
}

let _DownloadsCommon = null;
function getDownloadsCommon() {
  if (!_DownloadsCommon) {
    try {
      _DownloadsCommon = ChromeUtils.importESModule("resource:///modules/DownloadsCommon.sys.mjs").DownloadsCommon;
    } catch (_) {
      try {
        _DownloadsCommon = Services.wm?.getMostRecentWindow("navigator:browser")?.DownloadsCommon;
      } catch (_) {}
    }
  }
  return _DownloadsCommon;
}

/**
 * Resuelve una intención de navegación hacia un sitio web o consulta web.
 */
function resolveSiteUrl(target) {
  const clean = target.toLowerCase().trim();

  const SITE_MAP = {
    wikipedia: "https://es.wikipedia.org",
    google: "https://www.google.com",
    youtube: "https://www.youtube.com",
    github: "https://www.github.com",
    reddit: "https://www.reddit.com",
    twitter: "https://x.com",
    x: "https://x.com",
    facebook: "https://www.facebook.com",
    instagram: "https://www.instagram.com",
    whatsapp: "https://web.whatsapp.com",
    gmail: "https://mail.google.com",
    amazon: "https://www.amazon.com",
    noticias: "https://news.google.com",
    traductor: "https://translate.google.com",
  };

  if (SITE_MAP[clean]) {
    return SITE_MAP[clean];
  }

  // Proteger contra esquemas peligrosos (javascript:, data:, vbscript:)
  if (/^(?:javascript|data|vbscript):/i.test(clean)) {
    return `https://www.google.com/search?q=${encodeURIComponent(target)}`;
  }

  if (/^https?:\/\//i.test(clean)) {
    return clean;
  }

  // Si tiene formato de dominio (ej. wikipedia.org, github.io, elpais.com)
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+(\/.*)?$/i.test(clean)) {
    return `https://${clean}`;
  }

  // Si es una frase genérica de navegación, buscar en Google
  return `https://www.google.com/search?q=${encodeURIComponent(target)}`;
}

/**
 * Carga una URL en la pestaña activa del navegador.
 */
function openUrlInBrowser(topWin, url) {
  try {
    if (typeof topWin.openTrustedLinkIn === "function") {
      topWin.openTrustedLinkIn(url, "current");
      return;
    }
  } catch (_) {}

  try {
    const browser = topWin.gBrowser?.selectedBrowser;
    if (browser?.loadURI) {
      const uri = Services.io.newURI(url);
      browser.loadURI(uri, {
        triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
      });
      return;
    }
  } catch (_) {}
}

/**
 * Reproduce señales auditivas sintéticas elegantes (Earcons) mediante WebAudio en Gecko.
 * Cero archivos externos, latencia imperceptible (<1ms) y retroalimentación inmediata.
 * @param {"success" | "error" | "unrecognized" | "mute" | "unmute"} type
 * @param {ChromeWindow} topWin
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

    const AudioContextClass = win.AudioContext || win.webkitAudioContext;
    if (!AudioContextClass) return;

    if (!win._zenVoiceAudioCtx || win._zenVoiceAudioCtx.state === "closed") {
      win._zenVoiceAudioCtx = new AudioContextClass();
    }
    const ctx = win._zenVoiceAudioCtx;
    if (ctx.state === "suspended") {
      ctx.resume().catch(() => {});
    }

    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.connect(gain);
    gain.connect(ctx.destination);

    if (type === "success") {
      // Arpegio ascendente suave y gratificante: 540Hz -> 840Hz (130ms)
      osc.type = "sine";
      osc.frequency.setValueAtTime(540, now);
      osc.frequency.exponentialRampToValueAtTime(840, now + 0.12);
      gain.gain.setValueAtTime(0.09, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.14);
      osc.start(now);
      osc.stop(now + 0.14);
    } else if (type === "error" || type === "unrecognized") {
      // Tono descendente sordo y discreto: 320Hz -> 210Hz (160ms)
      osc.type = "triangle";
      osc.frequency.setValueAtTime(320, now);
      osc.frequency.exponentialRampToValueAtTime(210, now + 0.15);
      gain.gain.setValueAtTime(0.08, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.17);
      osc.start(now);
      osc.stop(now + 0.17);
    } else if (type === "mute") {
      // Tono suave de apagado: 400Hz -> 280Hz (110ms)
      osc.type = "sine";
      osc.frequency.setValueAtTime(400, now);
      osc.frequency.exponentialRampToValueAtTime(280, now + 0.1);
      gain.gain.setValueAtTime(0.07, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.12);
      osc.start(now);
      osc.stop(now + 0.12);
    } else if (type === "unmute") {
      // Tono brillante de encendido: 480Hz -> 740Hz (130ms)
      osc.type = "sine";
      osc.frequency.setValueAtTime(480, now);
      osc.frequency.exponentialRampToValueAtTime(740, now + 0.12);
      gain.gain.setValueAtTime(0.08, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.14);
      osc.start(now);
      osc.stop(now + 0.14);
    }
  } catch (_) {}
}

// Exponer en Services para llamadas globales
Services.zenPlayVoiceEarcon = playEarcon;

const WORD_TO_NUMBER = {
  uno: 1, un: 1, una: 1, primero: 1, primer: 1, primera: 1,
  dos: 2, segundo: 2, segunda: 2,
  tres: 3, tercero: 3, tercer: 3, tercera: 3,
  cuatro: 4, cuarto: 4, cuarta: 4,
  cinco: 5, quinto: 5, quinta: 5,
  seis: 6, sexto: 6, sexta: 6,
  siete: 7, septimo: 7, séptimo: 7, septima: 7, séptima: 7,
  ocho: 8, octavo: 8, octava: 8,
  nueve: 9, noveno: 9, novena: 9,
  diez: 10, decimo: 10, décimo: 10,
  once: 11, doce: 12, trece: 13, catorce: 14, quince: 15,
  dieciséis: 16, dieciseis: 16, diecisiete: 17, dieciocho: 18,
  diecinueve: 19, veinte: 20,
  veintiuno: 21, veintiun: 21, veintiún: 21, veintidós: 22, veintidos: 22, veintitrés: 23, veintitres: 23,
  veinticuatro: 24, veinticinco: 25, veintiséis: 26, veintiseis: 26, veintisiete: 27, veintiocho: 28, veintinueve: 29,
  treinta: 30,
  first: 1, one: 1, two: 2, second: 2,
  three: 3, third: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
};

/**
 * Resuelve si un comando corresponde a una selección numérica directa de un elemento en pantalla.
 * Soporta imperativos naturales: "presiona el 2", "pulsa el dos", "dale al 3", "haz clic en 4", "toca el 1".
 * @param {string} transcript - Texto del comando de voz.
 * @returns {number|null} - Índice 1-based del número seleccionado o null.
 */
export function parseNumericSelection(transcript) {
  if (!transcript || typeof transcript !== "string") return null;
  const clean = transcript.trim().toLowerCase();

  const prefix = "(?:(?:hacer\\s+clic|haz\\s+clic|haga\\s+clic|dar\\s+clic|da\\s+clic|clic|click|presionar|presiona|presione|pulsar|pulsa|pulse|apretar|aprieta|apriete|tocar|toca|toque|seleccionar|selecciona|seleccione|elegir|elige|elija|escoger|escoge|escoja|dar(?:le)?|dale|da|ir)(?:\\s+(?:en|a|al|sobre))?\\s*)?(?:(?:el|la|al|del)\\s+)?(?:n[uú]mero|opci[oó]n|bot[oó]n|enlace|resultado)?\\s*";

  // 1. Dígitos arábigos (ej. "1", "el 3", "presiona el 2", "dale al 5", "toca el 3")
  const numMatch = clean.match(new RegExp(`^${prefix}#?([0-9]{1,2})$`, "i"));
  if (numMatch && numMatch[1]) {
    const val = parseInt(numMatch[1], 10);
    if (val >= 1 && val <= 99) return val;
  }

  // 2. Números en palabras (ej. "el dos", "presiona el dos", "dale al dos", "opcion tres", "clic en cuatro")
  const wordMatch = clean.match(new RegExp(`^${prefix}([a-zñáéíóú]+)$`, "i"));
  if (wordMatch && wordMatch[1]) {
    const word = wordMatch[1].trim();
    if (WORD_TO_NUMBER[word] !== undefined) {
      return WORD_TO_NUMBER[word];
    }
  }

  return null;
}

/**
 * Renderiza un HUD flotante nativo a nivel de ventana del navegador (Chrome Window).
 * Inmune a problemas de z-index, iframes o páginas especiales (about:newtab, etc.).
 */
export function showNativeChromeHUD(topWin, { success = true, transcript = "", label = "", latencyMs = null }) {
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

  // Sanitización y actualización estructurada con DOM nodes (cero innerHTML)
  hud.textContent = "";

  // Borde y sombra temáticos dinámicos
  const glowColor = success ? "rgba(16, 185, 129, 0.4)" : "rgba(245, 158, 11, 0.4)";
  hud.style.borderColor = glowColor;
  hud.style.boxShadow = `0 14px 34px rgba(0, 0, 0, 0.45), 0 0 16px ${glowColor}`;

  // Icono indicador
  const icon = doc.createElementNS("http://www.w3.org/1999/xhtml", "span");
  icon.style.cssText = "font-size: 16px; display: flex; align-items: center; justify-content: center;";
  icon.textContent = success ? "🎤" : "⚠️";
  hud.appendChild(icon);

  // Columna de texto
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

  // Animación de entrada fluida
  hud.style.opacity = "1";
  hud.style.transform = "translateX(-50%) translateY(0)";

  // Feedback auditivo sutil (Earcon)
  playEarcon(success ? "success" : "error", win);

  // Limpiar temporizador previo
  if (win._zenkevChromeHudTimeout) {
    win.clearTimeout(win._zenkevChromeHudTimeout);
  }
  const isDemo = Services.prefs.getBoolPref("zen.voicenav.demo_mode", false);
  const displayDuration = isDemo ? 3800 : 2200;
  win._zenkevChromeHudTimeout = win.setTimeout(() => {
    if (hud) {
      hud.style.opacity = "0";
      hud.style.transform = "translateX(-50%) translateY(-14px)";
    }
  }, displayDuration);
}

// Exponer en Services para consumo global en Gecko
Services.zenShowVoiceHUD = showNativeChromeHUD;

/**
 * Genera el icono SVG data URI para el botón de voz según su estado.
 * @param {"listening" | "muted" | "processing"} state
 */
export function getVoiceNavButtonIcon(state = "listening") {
  let strokeColor = "#10b981"; // Verde esmeralda
  let centerFill = "#10b981";
  let pulseElement = `<circle cx="12" cy="8" r="2" fill="${centerFill}"/>`;

  if (state === "muted") {
    strokeColor = "#94a3b8"; // Gris pizarra silenciado
    pulseElement = `<line x1="4" y1="4" x2="20" y2="20" stroke="#ef4444" stroke-width="2.5" stroke-linecap="round"/>`;
  } else if (state === "processing") {
    strokeColor = "#c084fc"; // Púrpura brillante
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
export function updateVoiceNavButtonState(state) {
  const prevState = Services.zenVoiceNavButtonState;
  Services.zenVoiceNavButtonState = state;

  if (state === "muted" && prevState !== "muted") {
    playEarcon("mute");
  } else if (state === "listening" && prevState === "muted") {
    playEarcon("unmute");
  }

  const iconUri = getVoiceNavButtonIcon(state);

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
        btn.style.filter = "grayscale(90%) opacity(0.65)";
      } else if (state === "processing") {
        btn.setAttribute(
          "tooltiptext",
          "Zen Voice Navigator: Procesando orden..."
        );
        btn.style.filter = "drop-shadow(0 0 6px rgba(168, 85, 247, 0.8))";
      }
    }
  } catch (err) {
    logDebug(`Error al actualizar estado del botón: ${err}`);
  }
}

// Exponer en Services para consumo global
Services.zenSetVoiceState = updateVoiceNavButtonState;

let _zenVoiceNavWidgetRegistered = false;

/**
 * Registra el widget interactivo en CustomizableUI de Zen Browser.
 */
export function registerZenVoiceNavWidget() {
  if (_zenVoiceNavWidgetRegistered) return;

  let cui = null;
  try {
    const mod = ChromeUtils.importESModule(
      "moz-src:///browser/components/customizableui/CustomizableUI.sys.mjs"
    );
    cui = mod.CustomizableUI;
  } catch (_) {
    try {
      const mod = ChromeUtils.importESModule(
        "resource:///modules/CustomizableUI.sys.mjs"
      );
      cui = mod.CustomizableUI;
    } catch (_) {
      const win = Services.wm?.getMostRecentWindow("navigator:browser");
      cui = win?.CustomizableUI;
    }
  }

  if (!cui) {
    logDebug("No se pudo obtener CustomizableUI para registrar zen-voicenav-button");
    return;
  }

  if (cui.getWidget("zen-voicenav-button")) {
    _zenVoiceNavWidgetRegistered = true;
    return;
  }

  try {
    cui.createWidget({
      id: "zen-voicenav-button",
      type: "custom",
      defaultArea: cui.AREA_NAVBAR,
      removable: true,
      label: "Zen Voice Navigator",
      tooltiptext: "Zen Voice Navigator (Clic: Alternar Overlay [F2] | Shift+Clic: Silenciar)",
      onBuild(aDocument) {
        const btn = aDocument.createXULElement("toolbarbutton");
        btn.id = "zen-voicenav-button";
        btn.setAttribute("id", "zen-voicenav-button");
        btn.setAttribute("class", "toolbarbutton-1 chromeclass-toolbar-additional zen-voicenav-button");
        btn.setAttribute("label", "Zen Voice Navigator");
        btn.setAttribute(
          "tooltiptext",
          "Zen Voice Navigator (Clic: Alternar Overlay [F2] | Shift+Clic: Silenciar)"
        );
        btn.setAttribute("removable", "true");

        const state = Services.zenVoiceNavButtonState || "listening";
        const iconUri = getVoiceNavButtonIcon(state);
        btn.setAttribute("image", iconUri);

        const icon = aDocument.createXULElement("image");
        icon.setAttribute("class", "toolbarbutton-icon");
        icon.setAttribute("src", iconUri);
        btn.appendChild(icon);

        if (state === "muted") {
          btn.style.filter = "grayscale(90%) opacity(0.65)";
        } else if (state === "processing") {
          btn.style.filter = "drop-shadow(0 0 6px rgba(168, 85, 247, 0.8))";
        } else {
          btn.style.filter = "drop-shadow(0 0 3px rgba(16, 185, 129, 0.45))";
        }

        btn.addEventListener("command", (event) => {
          const win = aDocument.defaultView;
          if (!win) return;

          if (event.shiftKey) {
            const next = Services.zenVoiceNavButtonState === "muted" ? "listening" : "muted";
            updateVoiceNavButtonState(next);
            showNativeChromeHUD(win, {
              success: next === "listening",
              transcript: next === "listening" ? "Voz reactivada" : "Voz silenciada",
              label: next === "listening" ? "Escuchando" : "Silenciado",
            });
            return;
          }

          if (win.gZenVoiceNav?.toggleOverlay) {
            win.gZenVoiceNav.toggleOverlay();
          }
        });

        btn.addEventListener("click", (event) => {
          if (event.button === 1) { // Rueda de ratón / clic central
            event.preventDefault();
            event.stopPropagation();
            const win = aDocument.defaultView;
            const next = Services.zenVoiceNavButtonState === "muted" ? "listening" : "muted";
            updateVoiceNavButtonState(next);
            if (win) {
              showNativeChromeHUD(win, {
                success: next === "listening",
                transcript: next === "listening" ? "Voz reactivada" : "Voz silenciada",
                label: next === "listening" ? "Escuchando" : "Silenciado",
              });
            }
          }
        });

        return btn;
      },
    });

    _zenVoiceNavWidgetRegistered = true;
    logDebug("Widget zen-voicenav-button registrado con éxito en CustomizableUI");

    // Si aún no está en ningún área, colocarlo en AREA_NAVBAR
    const placement = cui.getPlacementOfWidget("zen-voicenav-button");
    if (!placement) {
      try {
        cui.addWidgetToArea("zen-voicenav-button", cui.AREA_NAVBAR);
      } catch (_) {}
    }
  } catch (err) {
    console.error("[ZenVoiceNavParent] Error al registrar widget en CustomizableUI:", err);
  }
}

try {
  registerZenVoiceNavWidget();
} catch (_) {}

/**
 * Ejecuta comandos globales de nivel de navegador (historial, pestañas, scroll, búsqueda, URLs).
 */
export async function executeGlobalVoiceCommand(transcript, topWin, actor = null) {
  if (!transcript || typeof transcript !== "string") return { handled: false };
  const text = transcript.trim().toLowerCase();
  const win = topWin || Services.wm?.getMostRecentWindow("navigator:browser");
  if (!win) return { handled: false };

  const gBrowser = win.gBrowser;

  function notifyHUD(success, label) {
    showNativeChromeHUD(win, { success, transcript, label, latencyMs: 0.1 });
    if (actor?.sendAsyncMessage) {
      try {
        actor.sendAsyncMessage("ZenVoiceNav:LogCommand", {
          transcript,
          success,
          decision: {
            action: label,
            latency_ms: 0.1,
          },
        });
      } catch (_) {}
    }
  }

  // 1. Historial de Navegación
  if (/^(?:ir\s+)?atr[aá]s$|^volver$|^retroceder$|^p[aá]gina\s+anterior$/i.test(text)) {
    logDebug("Comando global detectado: Atrás");
    if (gBrowser) {
      if (gBrowser.canGoBack) {
        gBrowser.goBack();
      } else if (gBrowser.selectedBrowser?.canGoBack) {
        gBrowser.selectedBrowser.goBack();
      }
    }
    notifyHUD(true, "Navegar atrás");
    return { handled: true, action: "history_back" };
  }

  if (/^(?:ir\s+)?adelante$|^avanzar$|^p[aá]gina\s+siguiente$/i.test(text)) {
    logDebug("Comando global detectado: Adelante");
    if (gBrowser) {
      if (gBrowser.canGoForward) {
        gBrowser.goForward();
      } else if (gBrowser.selectedBrowser?.canGoForward) {
        gBrowser.selectedBrowser.goForward();
      }
    }
    notifyHUD(true, "Navegar adelante");
    return { handled: true, action: "history_forward" };
  }

  if (/^recargar(?:\s+p[aá]gina)?$|^actualizar(?:\s+p[aá]gina)?$|^refrescar$/i.test(text)) {
    logDebug("Comando global detectado: Recargar página");
    if (gBrowser?.selectedTab) {
      gBrowser.reloadTab(gBrowser.selectedTab);
    } else if (win.BrowserReload) {
      win.BrowserReload();
    }
    notifyHUD(true, "Recargar página");
    return { handled: true, action: "page_reload" };
  }

  // Helper seguro para obtener pestañas abiertas válidas
  function getOpenTabs() {
    if (!gBrowser) return [];
    try {
      const rawTabs = gBrowser.visibleTabs || gBrowser.tabs || [];
      return Array.from(rawTabs).filter(t => !t.hidden && !t.closing);
    } catch (_) {
      return [];
    }
  }

  // 2. Control Integral de Pestañas y Ventanas
  // 2.1. Navegación entre Pestañas
  if (/^(?:siguiente\s+pesta[nñ]a|pesta[nñ]a\s+siguiente|avanzar\s+pesta[nñ]a|cambiar\s+pesta[nñ]a|next\s+tab)$/i.test(text)) {
    logDebug("Comando global detectado: Siguiente pestaña");
    try {
      if (gBrowser?.tabContainer?.advanceSelectedTab) {
        gBrowser.tabContainer.advanceSelectedTab(1, true);
      } else {
        const tabs = getOpenTabs();
        if (tabs.length > 1) {
          const idx = tabs.indexOf(gBrowser.selectedTab);
          gBrowser.selectedTab = tabs[(idx + 1) % tabs.length];
        }
      }
    } catch (e) {
      logDebug(`Error en siguiente pestaña: ${e}`);
    }
    notifyHUD(true, "Siguiente pestaña");
    return { handled: true, action: "next_tab" };
  }

  if (/^(?:pesta[nñ]a\s+anterior|anterior\s+pesta[nñ]a|retroceder\s+pesta[nñ]a|previous\s+tab)$/i.test(text)) {
    logDebug("Comando global detectado: Pestaña anterior");
    try {
      if (gBrowser?.tabContainer?.advanceSelectedTab) {
        gBrowser.tabContainer.advanceSelectedTab(-1, true);
      } else {
        const tabs = getOpenTabs();
        if (tabs.length > 1) {
          const idx = tabs.indexOf(gBrowser.selectedTab);
          gBrowser.selectedTab = tabs[(idx - 1 + tabs.length) % tabs.length];
        }
      }
    } catch (e) {
      logDebug(`Error en pestaña anterior: ${e}`);
    }
    notifyHUD(true, "Pestaña anterior");
    return { handled: true, action: "previous_tab" };
  }

  if (/^(?:(?:ir\s+a\s+(?:la\s+)?)?primera\s+pesta[nñ]a|pesta[nñ]a\s+inicial|first\s+tab)$/i.test(text)) {
    logDebug("Comando global detectado: Primera pestaña");
    const tabs = getOpenTabs();
    if (tabs.length > 0) {
      gBrowser.selectedTab = tabs[0];
      notifyHUD(true, "Primera pestaña");
      return { handled: true, action: "first_tab" };
    }
    notifyHUD(false, "No hay pestañas disponibles");
    return { handled: true, action: "first_tab_not_found" };
  }

  if (/^(?:(?:ir\s+a\s+(?:la\s+)?)?[uú]ltima\s+pesta[nñ]a|pesta[nñ]a\s+final|last\s+tab)$/i.test(text)) {
    logDebug("Comando global detectado: Última pestaña");
    const tabs = getOpenTabs();
    if (tabs.length > 0) {
      gBrowser.selectedTab = tabs[tabs.length - 1];
      notifyHUD(true, "Última pestaña");
      return { handled: true, action: "last_tab" };
    }
    notifyHUD(false, "No hay pestañas disponibles");
    return { handled: true, action: "last_tab_not_found" };
  }

  // Selección de pestaña por índice numérico (ej. "pestaña 2", "ir a la pestaña 3", "pestaña dos")
  const tabNumMatch = text.match(
    /^(?:(?:ir\s+a|cambiar\s+a|seleccionar|pasar\s+a)\s+(?:la\s+)?)?pesta[nñ]a(?:\s+n[uú]mero|\s+#)?\s+([0-9]{1,2}|[a-zñáéíóú]+)$/i
  );
  if (tabNumMatch && tabNumMatch[1]) {
    const rawVal = tabNumMatch[1].trim().toLowerCase();
    let tabIndex = null;
    if (/^[0-9]+$/.test(rawVal)) {
      tabIndex = parseInt(rawVal, 10);
    } else if (WORD_TO_NUMBER[rawVal] !== undefined) {
      tabIndex = WORD_TO_NUMBER[rawVal];
    }

    if (tabIndex !== null && tabIndex >= 1) {
      logDebug(`Comando global detectado: Ir a pestaña #${tabIndex}`);
      const tabs = getOpenTabs();
      if (tabIndex <= tabs.length) {
        gBrowser.selectedTab = tabs[tabIndex - 1];
        notifyHUD(true, `Pestaña ${tabIndex}`);
        return { handled: true, action: "select_tab_index", index: tabIndex };
      } else {
        notifyHUD(false, `Pestaña ${tabIndex} no existe (${tabs.length} abiertas)`);
        return { handled: true, action: "select_tab_index_out_of_range", index: tabIndex };
      }
    }
  }

  // 2.2. Gestión del Ciclo de Vida y Organización de Pestañas
  if (/^(?:(?:abrir|crear)\s+)?nueva\s+pesta[nñ]a$|^(?:abrir|crear)\s+pesta[nñ]a$|^new\s+tab$/i.test(text)) {
    logDebug("Comando global detectado: Nueva pestaña");
    try {
      if (typeof win.BrowserOpenTab === "function") {
        win.BrowserOpenTab();
      } else if (gBrowser?.addTrustedTab) {
        gBrowser.addTrustedTab("about:newtab");
      }
    } catch (e) {
      logDebug(`Error en BrowserOpenTab: ${e}`);
    }
    notifyHUD(true, "Nueva pestaña");
    return { handled: true, action: "new_tab" };
  }

  if (/^(?:cerrar\s+(?:esta\s+|la\s+)?pesta[nñ]a|quitar\s+(?:esta\s+|la\s+)?pesta[nñ]a|close\s+tab)$/i.test(text)) {
    logDebug("Comando global detectado: Cerrar pestaña");
    try {
      if (gBrowser?.selectedTab) {
        gBrowser.removeTab(gBrowser.selectedTab);
      }
    } catch (e) {
      logDebug(`Error en removeTab: ${e}`);
    }
    notifyHUD(true, "Cerrar pestaña");
    return { handled: true, action: "close_tab" };
  }

  if (/^(?:reabrir|restaurar|recuperar|deshacer\s+cerrar)\s+(?:[uú]ltima\s+)?pesta[nñ]a$|^reopen\s+tab$|^undo\s+close\s+tab$/i.test(text)) {
    logDebug("Comando global detectado: Reabrir pestaña cerrada");
    let restored = false;
    try {
      const closedCount = typeof win.SessionStore?.getClosedTabCount === "function" ? win.SessionStore.getClosedTabCount(win) : 1;
      if (closedCount > 0) {
        if (typeof win.SessionWindowUI?.undoCloseTab === "function") {
          win.SessionWindowUI.undoCloseTab(win);
          restored = true;
        } else if (typeof win.undoCloseTab === "function") {
          win.undoCloseTab();
          restored = true;
        } else if (typeof win.SessionStore?.undoCloseTab === "function") {
          win.SessionStore.undoCloseTab(win, 0);
          restored = true;
        } else if (typeof win.SessionWindowUI?.restoreLastClosedTabOrWindowOrSession === "function") {
          win.SessionWindowUI.restoreLastClosedTabOrWindowOrSession(win);
          restored = true;
        }
      }
    } catch (e) {
      logDebug(`Aviso al reabrir pestaña: ${e}`);
    }
    notifyHUD(restored, restored ? "Pestaña restaurada" : "No hay pestañas cerradas para reabrir");
    return { handled: true, action: "restore_tab", success: restored };
  }

  if (/^(?:cerrar\s+(?:las\s+)?(?:dem[aá]s|otras)\s+pesta[nñ]as|cerrar\s+resto\s+de\s+pesta[nñ]as|close\s+other\s+tabs)$/i.test(text)) {
    logDebug("Comando global detectado: Cerrar las demás pestañas");
    try {
      if (typeof gBrowser?.removeOtherTabs === "function" && gBrowser.selectedTab) {
        gBrowser.removeOtherTabs(gBrowser.selectedTab);
      } else if (gBrowser) {
        const current = gBrowser.selectedTab;
        const tabs = getOpenTabs();
        for (const t of tabs) {
          if (t !== current && !t.pinned) {
            gBrowser.removeTab(t);
          }
        }
      }
    } catch (e) {
      logDebug(`Error en removeOtherTabs: ${e}`);
    }
    notifyHUD(true, "Otras pestañas cerradas");
    return { handled: true, action: "close_other_tabs" };
  }

  if (/^(?:cerrar\s+(?:las\s+)?pesta[nñ]as\s+(?:a\s+la|de\s+la)\s+derecha|close\s+tabs\s+to\s+(?:the\s+)?right)$/i.test(text)) {
    logDebug("Comando global detectado: Cerrar pestañas a la derecha");
    try {
      if (typeof gBrowser?.removeTabsToTheEndFrom === "function" && gBrowser.selectedTab) {
        gBrowser.removeTabsToTheEndFrom(gBrowser.selectedTab);
      } else if (gBrowser) {
        const current = gBrowser.selectedTab;
        const tabs = getOpenTabs();
        const curIdx = tabs.indexOf(current);
        if (curIdx !== -1) {
          for (let i = tabs.length - 1; i > curIdx; i--) {
            if (!tabs[i].pinned) {
              gBrowser.removeTab(tabs[i]);
            }
          }
        }
      }
    } catch (e) {
      logDebug(`Error en removeTabsToTheEndFrom: ${e}`);
    }
    notifyHUD(true, "Pestañas a la derecha cerradas");
    return { handled: true, action: "close_tabs_to_right" };
  }

  if (/^(?:fijar|anclar|pinear)\s+pesta[nñ]a$|^pin\s+tab$/i.test(text)) {
    logDebug("Comando global detectado: Fijar pestaña");
    try {
      if (gBrowser?.selectedTab && !gBrowser.selectedTab.pinned) {
        gBrowser.pinTab(gBrowser.selectedTab);
      }
    } catch (e) {
      logDebug(`Error en pinTab: ${e}`);
    }
    notifyHUD(true, "Pestaña fijada");
    return { handled: true, action: "pin_tab" };
  }

  if (/^(?:desfijar|desanclar|despinear)\s+pesta[nñ]a$|^unpin\s+tab$/i.test(text)) {
    logDebug("Comando global detectado: Desfijar pestaña");
    try {
      if (gBrowser?.selectedTab && gBrowser.selectedTab.pinned) {
        gBrowser.unpinTab(gBrowser.selectedTab);
      }
    } catch (e) {
      logDebug(`Error en unpinTab: ${e}`);
    }
    notifyHUD(true, "Pestaña desfijada");
    return { handled: true, action: "unpin_tab" };
  }

  if (/^(?:alternar\s+fijar\s+pesta[nñ]a|fijar\s+o\s+desfijar\s+pesta[nñ]a|toggle\s+pin\s+tab)$/i.test(text)) {
    logDebug("Comando global detectado: Alternar fijar pestaña");
    let isPinned = false;
    try {
      if (gBrowser?.selectedTab) {
        if (gBrowser.selectedTab.pinned) {
          gBrowser.unpinTab(gBrowser.selectedTab);
          isPinned = false;
        } else {
          gBrowser.pinTab(gBrowser.selectedTab);
          isPinned = true;
        }
      }
    } catch (e) {
      logDebug(`Error en toggle pinTab: ${e}`);
    }
    notifyHUD(true, isPinned ? "Pestaña fijada" : "Pestaña desfijada");
    return { handled: true, action: "toggle_pin_tab", pinned: isPinned };
  }

  if (/^(?:duplicar|clonar)\s+pesta[nñ]a$|^duplicate\s+tab$/i.test(text)) {
    logDebug("Comando global detectado: Duplicar pestaña");
    try {
      if (gBrowser?.duplicateTab && gBrowser?.selectedTab) {
        gBrowser.duplicateTab(gBrowser.selectedTab);
      }
    } catch (e) {
      logDebug(`Error al duplicar pestaña: ${e}`);
    }
    notifyHUD(true, "Duplicar pestaña");
    return { handled: true, action: "duplicate_tab" };
  }

  if (/^(?:mover|desplazar)\s+pesta[nñ]a\s+(?:a\s+la\s+derecha|adelante)$/i.test(text)) {
    logDebug("Comando global detectado: Mover pestaña a la derecha");
    try {
      if (typeof gBrowser?.moveTabForward === "function") {
        gBrowser.moveTabForward();
      } else if (gBrowser?.selectedTab) {
        const tabs = Array.from(gBrowser.tabs);
        const idx = tabs.indexOf(gBrowser.selectedTab);
        if (idx < tabs.length - 1) {
          gBrowser.moveTabTo(gBrowser.selectedTab, idx + 1);
        }
      }
    } catch (e) {
      logDebug(`Error al mover pestaña a la derecha: ${e}`);
    }
    notifyHUD(true, "Pestaña movida a la derecha");
    return { handled: true, action: "move_tab_forward" };
  }

  if (/^(?:mover|desplazar)\s+pesta[nñ]a\s+(?:a\s+la\s+izquierda|atr[aá]s)$/i.test(text)) {
    logDebug("Comando global detectado: Mover pestaña a la izquierda");
    try {
      if (typeof gBrowser?.moveTabBackward === "function") {
        gBrowser.moveTabBackward();
      } else if (gBrowser?.selectedTab) {
        const tabs = Array.from(gBrowser.tabs);
        const idx = tabs.indexOf(gBrowser.selectedTab);
        if (idx > 0) {
          gBrowser.moveTabTo(gBrowser.selectedTab, idx - 1);
        }
      }
    } catch (e) {
      logDebug(`Error al mover pestaña a la izquierda: ${e}`);
    }
    notifyHUD(true, "Pestaña movida a la izquierda");
    return { handled: true, action: "move_tab_backward" };
  }

  if (/^(?:mover|desplazar)\s+pesta[nñ]a\s+(?:al\s+(?:principio|inicio)|a\s+la\s+primera\s+posici[oó]n)$/i.test(text)) {
    logDebug("Comando global detectado: Mover pestaña al inicio");
    try {
      if (typeof gBrowser?.moveTabToStart === "function") {
        gBrowser.moveTabToStart();
      } else if (gBrowser?.selectedTab) {
        gBrowser.moveTabTo(gBrowser.selectedTab, 0);
      }
    } catch (e) {
      logDebug(`Error al mover pestaña al inicio: ${e}`);
    }
    notifyHUD(true, "Pestaña movida al inicio");
    return { handled: true, action: "move_tab_start" };
  }

  if (/^(?:mover|desplazar)\s+pesta[nñ]a\s+(?:al\s+final|a\s+la\s+[uú]ltima\s+posici[oó]n)$/i.test(text)) {
    logDebug("Comando global detectado: Mover pestaña al final");
    try {
      if (typeof gBrowser?.moveTabToEnd === "function") {
        gBrowser.moveTabToEnd();
      } else if (gBrowser?.selectedTab) {
        const tabs = Array.from(gBrowser.tabs);
        gBrowser.moveTabTo(gBrowser.selectedTab, tabs.length - 1);
      }
    } catch (e) {
      logDebug(`Error al mover pestaña al final: ${e}`);
    }
    notifyHUD(true, "Pestaña movida al final");
    return { handled: true, action: "move_tab_end" };
  }

  // 2.3. Control de Ventanas del Navegador
  if (/^(?:nueva|abrir|crear)\s+ventana$|^new\s+window$/i.test(text)) {
    logDebug("Comando global detectado: Nueva ventana");
    try {
      if (typeof win.OpenBrowserWindow === "function") {
        win.OpenBrowserWindow();
      } else if (typeof win.openBrowserWindow === "function") {
        win.openBrowserWindow();
      }
    } catch (e) {
      logDebug(`Error al abrir nueva ventana: ${e}`);
    }
    notifyHUD(true, "Nueva ventana");
    return { handled: true, action: "new_window" };
  }

  if (/^(?:nueva\s+ventana\s+privada|abrir\s+ventana\s+privada|ventana\s+privada|(?:modo\s+)?inc[oó]gnito)$|^new\s+private\s+window$/i.test(text)) {
    logDebug("Comando global detectado: Nueva ventana privada");
    try {
      if (typeof win.OpenBrowserWindow === "function") {
        win.OpenBrowserWindow({ private: true });
      } else if (typeof win.openBrowserWindow === "function") {
        win.openBrowserWindow({ private: true });
      }
    } catch (e) {
      logDebug(`Error al abrir ventana privada: ${e}`);
    }
    notifyHUD(true, "Nueva ventana privada");
    return { handled: true, action: "new_private_window" };
  }

  if (/^cerrar\s+(?:esta\s+)?ventana$|^close\s+window$/i.test(text)) {
    logDebug("Comando global detectado: Cerrar ventana");
    try {
      if (typeof win.BrowserCloseWindow === "function") {
        win.BrowserCloseWindow();
      } else if (typeof win.close === "function") {
        win.close();
      }
    } catch (e) {
      logDebug(`Error al cerrar ventana: ${e}`);
    }
    notifyHUD(true, "Cerrar ventana");
    return { handled: true, action: "close_window" };
  }

  if (/^(?:reabrir|restaurar|recuperar)\s+ventana$|^reopen\s+window$/i.test(text)) {
    logDebug("Comando global detectado: Reabrir ventana cerrada");
    let restored = false;
    try {
      if (typeof win.SessionWindowUI?.undoCloseWindow === "function") {
        win.SessionWindowUI.undoCloseWindow();
        restored = true;
      } else if (typeof win.undoCloseWindow === "function") {
        win.undoCloseWindow();
        restored = true;
      } else if (typeof win.SessionStore?.undoCloseWindow === "function") {
        win.SessionStore.undoCloseWindow(0);
        restored = true;
      }
    } catch (e) {
      logDebug(`Error al reabrir ventana: ${e}`);
    }
    notifyHUD(restored, restored ? "Ventana restaurada" : "No hay ventanas para reabrir");
    return { handled: true, action: "restore_window", success: restored };
  }

  if (/^(?:minimizar\s+ventana|minimizar)$|^minimize\s+window$/i.test(text)) {
    logDebug("Comando global detectado: Minimizar ventana");
    try {
      if (typeof win.minimize === "function") {
        win.minimize();
      }
    } catch (e) {
      logDebug(`Error al minimizar ventana: ${e}`);
    }
    notifyHUD(true, "Ventana minimizada");
    return { handled: true, action: "minimize_window" };
  }

  if (/^(?:maximizar\s+ventana|maximizar|restaurar\s+ventana)$|^maximize\s+window$/i.test(text)) {
    logDebug("Comando global detectado: Maximizar / Restaurar ventana");
    let isMax = false;
    try {
      if (win.windowState === win.STATE_MAXIMIZED) {
        if (typeof win.restore === "function") win.restore();
        isMax = false;
      } else {
        if (typeof win.maximize === "function") win.maximize();
        isMax = true;
      }
    } catch (e) {
      logDebug(`Error al maximizar/restaurar ventana: ${e}`);
    }
    notifyHUD(true, isMax ? "Ventana maximizada" : "Ventana restaurada");
    return { handled: true, action: "toggle_maximize_window", maximized: isMax };
  }


  // 3. Zoom Accesible
  if (/^zoom\s+m[aá]s$|^aumentar\s+zoom$|^m[aá]s\s+zoom$/i.test(text)) {
    logDebug("Comando global detectado: Aumentar zoom");
    if (win.FullZoom?.enlarge) win.FullZoom.enlarge();
    notifyHUD(true, "Aumentar zoom");
    return { handled: true, action: "zoom_in" };
  }

  if (/^zoom\s+menos$|^reducir\s+zoom$|^menos\s+zoom$/i.test(text)) {
    logDebug("Comando global detectado: Reducir zoom");
    if (win.FullZoom?.reduce) win.FullZoom.reduce();
    notifyHUD(true, "Reducir zoom");
    return { handled: true, action: "zoom_out" };
  }

  if (/^restablecer\s+zoom$|^zoom\s+normal$|^zoom\s+100$/i.test(text)) {
    logDebug("Comando global detectado: Restablecer zoom");
    if (win.FullZoom?.reset) win.FullZoom.reset();
    notifyHUD(true, "Zoom 100%");
    return { handled: true, action: "zoom_reset" };
  }

  // 4. Desplazamiento (Scroll)
  if (/^bajar$|^scroll\s+abajo$|^desplazar\s+abajo$|^m[aá]s\s+abajo$|^baja$/i.test(text)) {
    logDebug("Comando global detectado: Scroll abajo");
    if (actor?.scroll) {
      await actor.scroll("down");
    }
    notifyHUD(true, "Desplazar hacia abajo");
    return { handled: true, action: "scroll_down" };
  }

  if (/^subir$|^scroll\s+arriba$|^desplazar\s+arriba$|^m[aá]s\s+arriba$|^sube$/i.test(text)) {
    logDebug("Comando global detectado: Scroll arriba");
    if (actor?.scroll) {
      await actor.scroll("up");
    }
    notifyHUD(true, "Desplazar hacia arriba");
    return { handled: true, action: "scroll_up" };
  }

  if (/^arriba\s+del\s+todo$|^al\s+principio$|^ir\s+al\s+inicio\s+de\s+p[aá]gina$/i.test(text)) {
    logDebug("Comando global detectado: Scroll arriba del todo");
    if (actor?.scroll) {
      await actor.scroll("top");
    }
    notifyHUD(true, "Ir arriba del todo");
    return { handled: true, action: "scroll_top" };
  }

  if (/^abajo\s+del\s+todo$|^al\s+final$|^final\s+de\s+la\s+p[aá]gina$/i.test(text)) {
    logDebug("Comando global detectado: Scroll abajo del todo");
    if (actor?.scroll) {
      await actor.scroll("bottom");
    }
    notifyHUD(true, "Ir abajo del todo");
    return { handled: true, action: "scroll_bottom" };
  }

  // 5. Búsqueda Web (ej. "buscar noticias de tecnología", "busca recetas fáciles")
  const searchMatch = text.match(/^(?:buscar|busca)(?:\s+en\s+google|\s+en\s+la\s+web)?(?!\s+(?:en\s+)?(?:los\s+)?marcador(?:es)?|\s+(?:en\s+)?(?:el\s+)?historial)\s+(.+)$/i);
  if (searchMatch && searchMatch[1]) {
    const query = searchMatch[1].trim();
    logDebug(`Comando global detectado: Búsqueda web para "${query}"`);
    const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}`;
    openUrlInBrowser(win, searchUrl);
    notifyHUD(true, `Búsqueda en Google: "${query}"`);
    return { handled: true, action: "web_search", query };
  }

  // 6. Modos Nativos de Zen y Firefox
  if (/^(?:modo\s+lectura|activar\s+(?:modo\s+)?lectura|vista\s+lectura|alternar\s+modo\s+lectura|lector)$/i.test(text)) {
    logDebug("Comando global detectado: Modo lectura");
    try {
      const readerBtn = win.document?.getElementById("reader-mode-button");
      if (readerBtn && !readerBtn.hidden) {
        readerBtn.click();
        notifyHUD(true, "Modo lectura");
        return { handled: true, action: "toggle_reader_mode" };
      }
      const browser = gBrowser?.selectedBrowser;
      if (browser) {
        if (win.AboutReaderParent?.toggleReaderMode) {
          win.AboutReaderParent.toggleReaderMode(browser);
        } else if (browser.toggleReaderMode) {
          browser.toggleReaderMode();
        }
        notifyHUD(true, "Modo lectura");
        return { handled: true, action: "toggle_reader_mode" };
      }
      notifyHUD(false, "Modo lectura no disponible");
      return { handled: true, action: "reader_mode_unavailable" };
    } catch (_) {
      notifyHUD(false, "Modo lectura no disponible");
      return { handled: true, action: "reader_mode_unavailable" };
    }
  }

  if (/^pantalla\s+completa$|^pantalla\s+entera$|^salir\s+de\s+pantalla\s+completa$/i.test(text)) {
    logDebug("Comando global detectado: Pantalla completa");
    try {
      if (typeof win.BrowserFullScreen === "function") {
        win.BrowserFullScreen();
      }
    } catch (e) {
      logDebug(`Error en BrowserFullScreen: ${e}`);
    }
    notifyHUD(true, "Pantalla completa");
    return { handled: true, action: "toggle_fullscreen" };
  }


  if (/^(?:silenciar|mutear)(?:\s+pesta[nñ]a)?$|^(?:activar|desmutear)\s+(?:sonido|audio)$/i.test(text)) {
    logDebug("Comando global detectado: Silenciar/Activar audio de pestaña");
    try {
      if (gBrowser?.selectedTab) {
        gBrowser.toggleMuteTab(gBrowser.selectedTab);
      }
    } catch (e) {
      logDebug(`Error en toggleMuteTab: ${e}`);
    }
    notifyHUD(true, "Audio de pestaña alternado");
    return { handled: true, action: "toggle_mute_tab" };
  }

  if (/^(?:abrir\s+)?descargas$/i.test(text)) {
    logDebug("Comando global detectado: Abrir descargas");
    try {
      if (typeof win.BrowserDownloadsUI === "function") {
        win.BrowserDownloadsUI();
      } else {
        openUrlInBrowser(win, "about:downloads");
      }
    } catch (e) {
      openUrlInBrowser(win, "about:downloads");
    }
    notifyHUD(true, "Descargas");
    return { handled: true, action: "open_downloads" };
  }

  if (/^(?:abrir\s+)?historial$/i.test(text)) {
    logDebug("Comando global detectado: Abrir historial");
    try {
      openUrlInBrowser(win, "about:history");
    } catch (e) {
      logDebug(`Error al abrir historial: ${e}`);
    }
    notifyHUD(true, "Historial");
    return { handled: true, action: "open_history" };
  }

  if (/^(?:abrir\s+)?configuraci[oó]n$|^(?:abrir\s+)?ajustes$/i.test(text)) {
    logDebug("Comando global detectado: Abrir configuración");
    try {
      if (typeof win.openPreferences === "function") {
        win.openPreferences();
      } else {
        openUrlInBrowser(win, "about:preferences");
      }
    } catch (e) {
      openUrlInBrowser(win, "about:preferences");
    }
    notifyHUD(true, "Configuración");
    return { handled: true, action: "open_preferences" };
  }

  // 6.5. Control de Estado de Voz (Silenciar / Activar micrófono)
  if (/^(?:silenciar|desactivar|pausar)\s+voz$/i.test(text)) {
    logDebug("Comando global detectado: Silenciar voz");
    updateVoiceNavButtonState("muted");
    notifyHUD(true, "Voz silenciada");
    return { handled: true, action: "mute_voice" };
  }

  if (/^(?:activar|reanudar|desmutear)\s+voz$/i.test(text)) {
    logDebug("Comando global detectado: Reactivar voz");
    updateVoiceNavButtonState("listening");
    notifyHUD(true, "Voz reactivada");
    return { handled: true, action: "unmute_voice" };
  }

  // 6.8. Control Nativo de Zen Spaces / Workspaces (Opción 4)
  if (/^(?:siguiente\s+espacio|espacio\s+siguiente|avanzar\s+espacio|next\s+(?:space|workspace))$/i.test(text)) {
    logDebug("Comando global detectado: Siguiente espacio Zen");
    try {
      if (win.gZenWorkspaces?.changeWorkspaceShortcut) {
        await win.gZenWorkspaces.changeWorkspaceShortcut(1);
      }
    } catch (e) {
      logDebug(`Error en siguiente espacio: ${e}`);
    }
    notifyHUD(true, "Siguiente espacio");
    return { handled: true, action: "next_workspace" };
  }

  if (/^(?:anterior\s+espacio|espacio\s+anterior|retroceder\s+espacio|previous\s+(?:space|workspace))$/i.test(text)) {
    logDebug("Comando global detectado: Espacio anterior Zen");
    try {
      if (win.gZenWorkspaces?.changeWorkspaceShortcut) {
        await win.gZenWorkspaces.changeWorkspaceShortcut(-1);
      }
    } catch (e) {
      logDebug(`Error en anterior espacio: ${e}`);
    }
    notifyHUD(true, "Espacio anterior");
    return { handled: true, action: "previous_workspace" };
  }

  if (/^(?:(?:ir\s+al\s+)?primer\s+espacio|espacio\s+inicial)$/i.test(text)) {
    logDebug("Comando global detectado: Primer espacio Zen");
    try {
      const spaces = win.gZenWorkspaces?.getWorkspaces?.() || [];
      if (spaces.length > 0) {
        await win.gZenWorkspaces.changeWorkspace(spaces[0]);
      }
    } catch (e) {
      logDebug(`Error en primer espacio: ${e}`);
    }
    notifyHUD(true, "Primer espacio");
    return { handled: true, action: "first_workspace" };
  }

  if (/^(?:(?:ir\s+al\s+)?[uú]ltimo\s+espacio|espacio\s+final)$/i.test(text)) {
    logDebug("Comando global detectado: Último espacio Zen");
    try {
      const spaces = win.gZenWorkspaces?.getWorkspaces?.() || [];
      if (spaces.length > 0) {
        await win.gZenWorkspaces.changeWorkspace(spaces[spaces.length - 1]);
      }
    } catch (e) {
      logDebug(`Error en último espacio: ${e}`);
    }
    notifyHUD(true, "Último espacio");
    return { handled: true, action: "last_workspace" };
  }

  if (/^(?:nuevo|crear|abrir)\s+espacio$/i.test(text)) {
    logDebug("Comando global detectado: Crear nuevo espacio Zen");
    try {
      if (win.gZenWorkspaces?.openWorkspaceCreation) {
        win.gZenWorkspaces.openWorkspaceCreation();
      }
    } catch (e) {
      logDebug(`Error al abrir creación de espacio: ${e}`);
    }
    notifyHUD(true, "Crear espacio");
    return { handled: true, action: "create_workspace" };
  }

  if (/^(?:cerrar\s+pesta[nñ]as\s+del\s+espacio|limpiar\s+espacio)$/i.test(text)) {
    logDebug("Comando global detectado: Cerrar pestañas no ancladas del espacio");
    try {
      if (win.gZenWorkspaces?.closeAllUnpinnedTabs) {
        await win.gZenWorkspaces.closeAllUnpinnedTabs();
      }
    } catch (e) {
      logDebug(`Error en closeAllUnpinnedTabs: ${e}`);
    }
    notifyHUD(true, "Pestañas del espacio cerradas");
    return { handled: true, action: "close_workspace_tabs" };
  }

  const spaceMatch = text.match(/^(?:(?:ir\s+al|cambiar\s+al|pasar\s+al)\s+)?espacio\s+(?:n[uú]mero\s+|#)?(.+)$/i);
  if (spaceMatch && spaceMatch[1]) {
    const rawTarget = spaceMatch[1].trim().toLowerCase();
    logDebug(`Comando global detectado: Cambiar a espacio "${rawTarget}"`);
    try {
      const spaces = win.gZenWorkspaces?.getWorkspaces?.() || [];
      let targetSpace = null;
      let spaceNum = null;
      if (/^[0-9]+$/.test(rawTarget)) {
        spaceNum = parseInt(rawTarget, 10);
      } else if (WORD_TO_NUMBER[rawTarget] !== undefined) {
        spaceNum = WORD_TO_NUMBER[rawTarget];
      }

      if (spaceNum !== null && spaceNum >= 1 && spaceNum <= spaces.length) {
        targetSpace = spaces[spaceNum - 1];
      } else {
        targetSpace = spaces.find(s => s.name?.toLowerCase().includes(rawTarget));
      }

      if (targetSpace) {
        await win.gZenWorkspaces.changeWorkspace(targetSpace);
        notifyHUD(true, `Espacio: ${targetSpace.name}`);
        return { handled: true, action: "switch_workspace", name: targetSpace.name };
      } else {
        notifyHUD(false, `Espacio "${rawTarget}" no encontrado`);
        return { handled: true, action: "workspace_not_found", query: rawTarget };
      }
    } catch (e) {
      logDebug(`Error al cambiar de espacio: ${e}`);
    }
  }

  // 7. Historial, Marcadores y Descargas por Voz (Opción 5)
  // 7.1 Marcadores: Marcar / Guardar página actual
  if (/^(?:marcar(?:\s+esta)?\s+p[aá]gina|guardar\s+(?:en\s+)?marcadores|guardar\s+marcador|a[nñ]adir\s+a\s+marcadores|agregar\s+a\s+marcadores|bookmark(?:\s+page)?)$/i.test(text)) {
    logDebug("Comando global detectado: Marcar página actual");
    try {
      if (win.PlacesCommandHook?.bookmarkPage) {
        await win.PlacesCommandHook.bookmarkPage();
      } else if (win.BookmarkingUI?.star) {
        win.BookmarkingUI.star.click();
      } else {
        const pu = getPlacesUtils();
        if (pu && gBrowser?.selectedBrowser?.currentURI) {
          const url = gBrowser.selectedBrowser.currentURI.spec;
          const title = gBrowser.selectedBrowser.contentTitle || url;
          await pu.bookmarks.insert({
            parentGuid: pu.bookmarks.unfiledGuid,
            url,
            title,
          });
        }
      }
      notifyHUD(true, "Página guardada en marcadores");
      return { handled: true, action: "bookmark_page" };
    } catch (e) {
      logDebug(`Error al marcar página: ${e}`);
      notifyHUD(false, "Error al guardar marcador");
      return { handled: true, action: "bookmark_page_error", error: String(e) };
    }
  }

  // 7.2 Marcadores: Eliminar / Quitar marcador de página actual
  if (/^(?:eliminar|quitar|borrar|remover)\s+marcador(?:\s+de\s+(?:esta\s+)?p[aá]gina)?$|^desmarcar(?:\s+esta)?\s+p[aá]gina$/i.test(text)) {
    logDebug("Comando global detectado: Eliminar marcador de página actual");
    try {
      const pu = getPlacesUtils();
      const currentUrl = gBrowser?.selectedBrowser?.currentURI?.spec;
      let removed = false;
      if (pu && currentUrl) {
        const bm = await pu.bookmarks.fetch({ url: currentUrl });
        if (bm?.guid) {
          await pu.bookmarks.remove(bm.guid);
          removed = true;
        }
      }
      if (!removed && win.BookmarkingUI?.status === win.BookmarkingUI?.STATUS_STARRED) {
        win.BookmarkingUI.star?.click();
        removed = true;
      }
      if (removed) {
        notifyHUD(true, "Marcador eliminado");
        return { handled: true, action: "unbookmark_page" };
      } else {
        notifyHUD(false, "Esta página no está en marcadores");
        return { handled: true, action: "unbookmark_page_not_found" };
      }
    } catch (e) {
      logDebug(`Error al desmarcar página: ${e}`);
      notifyHUD(false, "Error al quitar marcador");
      return { handled: true, action: "unbookmark_error", error: String(e) };
    }
  }

  // 7.3 Marcadores: Abrir / Alternar barra lateral o panel
  if (/^(?:abrir|mostrar|ver|alternar)\s+(?:los\s+)?marcadores$|^(?:barra\s+lateral\s+de\s+marcadores|panel\s+de\s+marcadores)$/i.test(text)) {
    logDebug("Comando global detectado: Alternar marcadores");
    try {
      if (win.SidebarController?.toggle) {
        win.SidebarController.toggle("viewBookmarksSidebar");
      } else if (win.PlacesCommandHook?.showPlacesOrganizer) {
        win.PlacesCommandHook.showPlacesOrganizer("AllBookmarks");
      }
      notifyHUD(true, "Marcadores");
      return { handled: true, action: "toggle_bookmarks_sidebar" };
    } catch (e) {
      logDebug(`Error al alternar marcadores: ${e}`);
    }
  }

  // 7.4 Marcadores: Abrir Biblioteca / Organizador
  if (/^(?:biblioteca|organizador|gestor)\s+de\s+marcadores$|^abrir\s+(?:la\s+)?biblioteca\s+de\s+marcadores$/i.test(text)) {
    logDebug("Comando global detectado: Biblioteca de marcadores");
    try {
      if (win.PlacesCommandHook?.showPlacesOrganizer) {
        win.PlacesCommandHook.showPlacesOrganizer("AllBookmarks");
      }
      notifyHUD(true, "Biblioteca de marcadores");
      return { handled: true, action: "open_bookmarks_organizer" };
    } catch (e) {
      logDebug(`Error al abrir biblioteca de marcadores: ${e}`);
    }
  }

  // 7.5 Marcadores: Alternar barra de marcadores (toolbar)
  if (/^(?:barra\s+de\s+marcadores|mostrar\s+barra\s+de\s+marcadores|ocultar\s+barra\s+de\s+marcadores|alternar\s+barra\s+de\s+marcadores)$/i.test(text)) {
    logDebug("Comando global detectado: Alternar barra de marcadores");
    try {
      if (win.BookmarkingUI?.toggleBookmarksToolbar) {
        win.BookmarkingUI.toggleBookmarksToolbar("shortcut");
      }
      notifyHUD(true, "Barra de marcadores");
      return { handled: true, action: "toggle_bookmarks_toolbar" };
    } catch (e) {
      logDebug(`Error en barra de marcadores: ${e}`);
    }
  }

  // 7.6 Marcadores: Buscar en marcadores
  const bmSearchMatch = text.match(/^(?:buscar\s+en\s+marcadores|buscar\s+marcador(?:es)?)\s+(.+)$/i);
  if (bmSearchMatch && bmSearchMatch[1]) {
    const term = bmSearchMatch[1].trim();
    logDebug(`Comando global detectado: Buscar en marcadores "${term}"`);
    try {
      if (win.gURLBar) {
        win.gURLBar.search("* " + term, { searchModeEntry: "bookmarkmenu" });
        notifyHUD(true, `Buscando en marcadores: ${term}`);
        return { handled: true, action: "search_bookmarks", query: term };
      }
    } catch (e) {
      logDebug(`Error al buscar en marcadores: ${e}`);
    }
  }

  // 7.7 Marcadores: Abrir marcador específico por nombre (ej. "abrir marcador github", "marcador youtube")
  const openBmMatch = text.match(/^(?:abrir\s+marcador|ir\s+a\s+marcador|marcador)\s+(.+)$/i);
  if (openBmMatch && openBmMatch[1]) {
    const rawTarget = openBmMatch[1].trim();
    logDebug(`Comando global detectado: Abrir marcador "${rawTarget}"`);
    try {
      const pu = getPlacesUtils();
      if (pu?.bookmarks?.search) {
        const results = await pu.bookmarks.search({ query: rawTarget });
        if (results && results.length > 0) {
          const lower = rawTarget.toLowerCase();
          let best = results.find(b => b.title && b.title.toLowerCase() === lower);
          if (!best) {
            best = results.find(b => b.title && b.title.toLowerCase().includes(lower));
          }
          if (!best) {
            best = results[0];
          }
          const targetUrl = best.url ? (best.url.href || best.url.spec || best.url.toString()) : null;
          if (targetUrl) {
            openUrlInBrowser(win, targetUrl);
            notifyHUD(true, `Marcador: ${best.title || rawTarget}`);
            return { handled: true, action: "open_bookmark", title: best.title, url: targetUrl };
          }
        }
      }
      notifyHUD(false, `Marcador "${rawTarget}" no encontrado`);
      return { handled: true, action: "bookmark_not_found", query: rawTarget };
    } catch (e) {
      logDebug(`Error al abrir marcador: ${e}`);
    }
  }

  // 7.8 Historial: Abrir / Alternar barra lateral o panel
  if (/^(?:abrir|mostrar|ver|alternar)\s+(?:el\s+)?historial$|^(?:barra\s+lateral\s+de\s+historial|panel\s+de\s+historial)$/i.test(text)) {
    logDebug("Comando global detectado: Alternar historial");
    try {
      if (win.SidebarController?.toggle) {
        win.SidebarController.toggle("viewHistorySidebar");
      } else if (win.PlacesCommandHook?.showPlacesOrganizer) {
        win.PlacesCommandHook.showPlacesOrganizer("History");
      }
      notifyHUD(true, "Historial");
      return { handled: true, action: "toggle_history_sidebar" };
    } catch (e) {
      logDebug(`Error al alternar historial: ${e}`);
    }
  }

  // 7.9 Historial: Abrir Biblioteca / Organizador
  if (/^(?:biblioteca|organizador|gestor)\s+de\s+historial$|^abrir\s+(?:la\s+)?biblioteca\s+de\s+historial$/i.test(text)) {
    logDebug("Comando global detectado: Biblioteca de historial");
    try {
      if (win.PlacesCommandHook?.showPlacesOrganizer) {
        win.PlacesCommandHook.showPlacesOrganizer("History");
      }
      notifyHUD(true, "Biblioteca de historial");
      return { handled: true, action: "open_history_organizer" };
    } catch (e) {
      logDebug(`Error al abrir biblioteca de historial: ${e}`);
    }
  }

  // 7.10 Historial: Buscar en historial (ej. "buscar en historial firefox", "historial zen")
  const histSearchMatch = text.match(/^(?:buscar\s+en\s+(?:el\s+)?historial|buscar\s+historial|historial)\s+(.+)$/i);
  if (histSearchMatch && histSearchMatch[1]) {
    const term = histSearchMatch[1].trim();
    logDebug(`Comando global detectado: Buscar en historial "${term}"`);
    try {
      if (win.gURLBar) {
        win.gURLBar.search("^ " + term, { searchModeEntry: "historymenu" });
        notifyHUD(true, `Buscando en historial: ${term}`);
        return { handled: true, action: "search_history", query: term };
      }
    } catch (e) {
      logDebug(`Error al buscar en historial: ${e}`);
    }
  }

  // 7.11 Historial: Limpiar historial reciente
  if (/^(?:limpiar|borrar|vaciar)\s+(?:el\s+)?historial(?:\s+reciente)?$/i.test(text)) {
    logDebug("Comando global detectado: Limpiar historial reciente");
    try {
      if (win.Sanitizer?.showUI) {
        win.Sanitizer.showUI(win);
      } else {
        win.openDialog(
          "chrome://browser/content/sanitize.xhtml",
          "Sanitize",
          "chrome,titlebar,dialog=yes,modal=yes,centerscreen"
        );
      }
      notifyHUD(true, "Limpiar historial");
      return { handled: true, action: "clear_history_dialog" };
    } catch (e) {
      logDebug(`Error al abrir diálogo de limpiar historial: ${e}`);
    }
  }

  // 7.12 Descargas: Abrir Panel / Vista de descargas
  if (/^(?:abrir|mostrar|ver)\s+(?:las\s+)?descargas$|^(?:panel\s+de\s+descargas|mis\s+descargas)$/i.test(text)) {
    logDebug("Comando global detectado: Abrir panel de descargas");
    try {
      if (win.BrowserCommands?.downloadsUI) {
        win.BrowserCommands.downloadsUI();
      } else if (win.DownloadsPanel?.showDownloadsHistory) {
        win.DownloadsPanel.showDownloadsHistory();
      } else if (win.PlacesCommandHook?.showPlacesOrganizer) {
        win.PlacesCommandHook.showPlacesOrganizer("Downloads");
      }
      notifyHUD(true, "Descargas");
      return { handled: true, action: "open_downloads_ui" };
    } catch (e) {
      logDebug(`Error al abrir descargas: ${e}`);
    }
  }

  // 7.13 Descargas: Biblioteca / Página completa de descargas
  if (/^(?:biblioteca|p[aá]gina|gestor)\s+de\s+descargas$|^abrir\s+(?:la\s+)?biblioteca\s+de\s+descargas$/i.test(text)) {
    logDebug("Comando global detectado: Biblioteca de descargas");
    try {
      openUrlInBrowser(win, "about:downloads");
      notifyHUD(true, "Biblioteca de descargas");
      return { handled: true, action: "open_downloads_page" };
    } catch (e) {
      logDebug(`Error al abrir página de descargas: ${e}`);
    }
  }

  // 7.14 Descargas: Limpiar descargas finalizadas
  if (/^(?:limpiar|borrar|vaciar)\s+(?:las\s+)?descargas(?:\s+completadas|\s+finalizadas)?$/i.test(text)) {
    logDebug("Comando global detectado: Limpiar descargas");
    try {
      const dc = getDownloadsCommon();
      if (dc?.getData) {
        dc.getData(win).removeFinished();
      } else if (win.document?.getElementById("downloadsCmd_clearList")) {
        win.document.getElementById("downloadsCmd_clearList").doCommand();
      }
      notifyHUD(true, "Descargas limpiadas");
      return { handled: true, action: "clear_downloads" };
    } catch (e) {
      logDebug(`Error al limpiar descargas: ${e}`);
    }
  }

  // 7.15 Extras: Guardar página / Imprimir
  if (/^(?:guardar\s+p[aá]gina|guardar\s+como)$/i.test(text)) {
    logDebug("Comando global detectado: Guardar página");
    try {
      if (win.saveBrowser && gBrowser?.selectedBrowser) {
        win.saveBrowser(gBrowser.selectedBrowser);
        notifyHUD(true, "Guardar página");
        return { handled: true, action: "save_page" };
      }
    } catch (e) {
      logDebug(`Error al guardar página: ${e}`);
    }
  }

  if (/^(?:imprimir\s+p[aá]gina|imprimir)$/i.test(text)) {
    logDebug("Comando global detectado: Imprimir");
    try {
      if (win.PrintUtils?.startPrintWindow && gBrowser?.selectedBrowser?.browsingContext) {
        win.PrintUtils.startPrintWindow(gBrowser.selectedBrowser.browsingContext);
        notifyHUD(true, "Imprimir");
        return { handled: true, action: "print_page" };
      }
    } catch (e) {
      logDebug(`Error al imprimir: ${e}`);
    }
  }

  // Modo Demostración / Presentación (pacing observable para videos y tutoriales)
  if (/^(?:activar\s+)?modo\s+(?:demo|demostraci[oó]n|presentaci[oó]n)$|^(?:iniciar|comenzar|empezar|activar)\s+demo$/i.test(text)) {
    logDebug("Comando global detectado: Activar modo demostración");
    Services.prefs.setBoolPref("zen.voicenav.demo_mode", true);
    notifyHUD(true, "Modo Demostración Activado (ritmo observable)");
    return { handled: true, action: "demo_mode_on" };
  }

  if (/^(?:desactivar|quitar|apagar|detener|parar|terminar|cerrar|salir\s+de)\s+(?:el\s+)?modo\s+(?:demo|demostraci[oó]n|presentaci[oó]n)$|^(?:desactivar|apagar|detener|parar|terminar|cerrar|salir\s+de)\s+demo$|^modo\s+normal$/i.test(text)) {
    logDebug("Comando global detectado: Desactivar modo demostración");
    Services.prefs.setBoolPref("zen.voicenav.demo_mode", false);
    notifyHUD(true, "Modo Normal Activado (0.1ms ultrarrápido)");
    return { handled: true, action: "demo_mode_off" };
  }

  // Control de Superposición Visual / Atajos Numéricos (Badges)
  if (/^(?:mostrar|ver|activar|abrir|poner)\s+(?:los\s+)?n[uú]meros$|^n[uú]meros$/i.test(text)) {
    logDebug("Comando global detectado: Mostrar números");
    try {
      if (win.gZenVoiceNav?.showOverlay) {
        await win.gZenVoiceNav.showOverlay();
        win._zenVoiceNavOverlayActive = true;
      } else {
        const a = actor || win.gBrowser?.selectedBrowser?.browsingContext?.currentWindowGlobal?.getActor("ZenVoiceNav");
        if (a) {
          const r = await a.getCandidates(true);
          await a.showVisualOverlay(r?.candidates || []);
          win._zenVoiceNavOverlayActive = true;
        }
      }
    } catch (e) {
      logDebug(`Error al mostrar números: ${e}`);
    }
    notifyHUD(true, "Atajos numéricos activados");
    return { handled: true, action: "show_numbers" };
  }

  if (/^(?:ocultar|quitar|cerrar|esconder|desactivar|apagar)\s+(?:los\s+)?n[uú]meros$/i.test(text)) {
    logDebug("Comando global detectado: Ocultar números");
    try {
      if (win.gZenVoiceNav?.hideOverlay) {
        await win.gZenVoiceNav.hideOverlay();
        win._zenVoiceNavOverlayActive = false;
      } else {
        const a = actor || win.gBrowser?.selectedBrowser?.browsingContext?.currentWindowGlobal?.getActor("ZenVoiceNav");
        if (a) {
          await a.hideVisualOverlay();
          win._zenVoiceNavOverlayActive = false;
        }
      }
    } catch (e) {
      logDebug(`Error al ocultar números: ${e}`);
    }
    notifyHUD(true, "Atajos numéricos desactivados");
    return { handled: true, action: "hide_numbers" };
  }

  // 8. Ir a URL o Sitio Web (ej. "ir a wikipedia", "abrir youtube", "navegar a github.com")
  const navMatch = text.match(/^(?:ir\s+a|abrir|navegar\s+a|entrar\s+a)\s+(.+)$/i);
  if (navMatch && navMatch[1]) {
    const target = navMatch[1].trim();
    const resolvedUrl = resolveSiteUrl(target);
    logDebug(`Comando global detectado: Navegar a "${target}" -> ${resolvedUrl}`);
    openUrlInBrowser(win, resolvedUrl);
    notifyHUD(true, `Navegando a: ${target}`);
    return { handled: true, action: "navigate_url", url: resolvedUrl };
  }

  return { handled: false };
}

export function initZenVoiceNav(topWin) {
  if (!topWin || topWin._zenVoiceNavInitialized) return;
  topWin._zenVoiceNavInitialized = true;

  // Desactivar popups molestos no solicitados (como traducción automática de páginas)
  try {
    Services.prefs.setBoolPref("browser.translations.automaticallyPopup", false);
  } catch (_) {}

  registerZenVoiceNavWidget();

  topWin.gZenVoiceNav = {
    getActor: () => {
      try {
        return topWin.gBrowser?.selectedBrowser?.browsingContext?.currentWindowGlobal?.getActor("ZenVoiceNav");
      } catch (_) {
        return null;
      }
    },
    getCandidates: async (onlyVisible = true) => {
      let actor = null;
      try {
        actor = topWin.gBrowser?.selectedBrowser?.browsingContext?.currentWindowGlobal?.getActor("ZenVoiceNav");
      } catch (_) {}
      return actor ? await actor.getCandidates(onlyVisible) : { candidates: [], error: "No actor" };
    },
    showOverlay: async () => {
      let actor = null;
      try {
        actor = topWin.gBrowser?.selectedBrowser?.browsingContext?.currentWindowGlobal?.getActor("ZenVoiceNav");
      } catch (_) {}
      if (!actor) return { success: false, error: "No actor" };
      const r = await actor.getCandidates(true);
      return await actor.showVisualOverlay(r.candidates || []);
    },
    hideOverlay: async () => {
      let actor = null;
      try {
        actor = topWin.gBrowser?.selectedBrowser?.browsingContext?.currentWindowGlobal?.getActor("ZenVoiceNav");
      } catch (_) {}
      return actor ? await actor.hideVisualOverlay() : { success: false };
    },
    toggleMute: () => {
      const next = Services.zenVoiceNavButtonState === "muted" ? "listening" : "muted";
      updateVoiceNavButtonState(next);
      showNativeChromeHUD(topWin, {
        success: next === "listening",
        transcript: next === "listening" ? "Voz reactivada" : "Voz silenciada",
        label: next === "listening" ? "Escuchando" : "Silenciado",
      });
      return next;
    },
    setButtonState: (state) => {
      updateVoiceNavButtonState(state);
    },
    processCommand: async (transcript) => {
      const wasMuted = Services.zenVoiceNavButtonState === "muted";
      if (wasMuted) {
        if (/^(?:activar|reanudar|desmutear)\s+voz$/i.test(transcript.trim())) {
          return await executeGlobalVoiceCommand(transcript, topWin, null);
        }
        logDebug(`Comando ignorado por estar silenciado: "${transcript}"`);
        return { handled: false, muted: true };
      }

      updateVoiceNavButtonState("processing");
      try {
        // 1. Prioridad: Comandos globales del navegador (abrir URLs, búsquedas, pestañas, etc.)
        const globalRes = await executeGlobalVoiceCommand(transcript, topWin, null);
        if (globalRes && globalRes.handled) {
          return globalRes;
        }

        // 2. Comandos en página interactivos (botones, enlaces, inputs)
        let actor = null;
        try {
          actor = topWin.gBrowser?.selectedBrowser?.browsingContext?.currentWindowGlobal?.getActor("ZenVoiceNav");
        } catch (_) {}
        if (actor) {
          return await actor.processVoiceCommand(transcript);
        }
        return { success: false, error: "No actor" };
      } finally {
        updateVoiceNavButtonState(Services.zenVoiceNavButtonState === "muted" ? "muted" : "listening");
      }
    },
    toggleOverlay: async () => {
      let actor = null;
      try {
        actor = topWin.gBrowser?.selectedBrowser?.browsingContext?.currentWindowGlobal?.getActor("ZenVoiceNav");
      } catch (_) {}
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
   * Desplaza suavemente la ventana activa en el proceso de contenido.
   * @param {string} direction - "down" | "up" | "top" | "bottom"
   * @param {number|null} amount - Píxeles a desplazar (opcional).
   */
  async scroll(direction, amount = null) {
    try {
      return await this.sendQuery("ZenVoiceNav:Scroll", { direction, amount });
    } catch (e) {
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
   * Dictado Inteligente: escribe o concatena texto en un campo de entrada.
   */
  async setInputValue(targetId, value, append = false, submit = false) {
    try {
      let isDemo = false;
      try {
        isDemo = Services.prefs.getBoolPref("zen.voicenav.demo_mode", false);
      } catch (_) {}
      return await this.sendQuery("ZenVoiceNav:SetInputValue", {
        targetId: targetId ? String(targetId) : null,
        value,
        append,
        submit,
        typewriter: isDemo,
      });
    } catch (e) {
      console.error(`[ZenVoiceNavParent] Error en setInputValue:`, e);
      return { success: false, error: e.message };
    }
  }

  /**
   * Limpia un campo de texto en la página.
   */
  async clearInput(targetId = null) {
    try {
      return await this.sendQuery("ZenVoiceNav:ClearInput", {
        targetId: targetId ? String(targetId) : null,
      });
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  /**
   * Envía un formulario asociado al campo o página.
   */
  async submitForm(targetId = null) {
    try {
      return await this.sendQuery("ZenVoiceNav:SubmitForm", {
        targetId: targetId ? String(targetId) : null,
      });
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  /**
   * Simula la tecla Enter en la página activa.
   */
  async pressEnter(targetId = null) {
    try {
      return await this.sendQuery("ZenVoiceNav:PressEnter", {
        targetId: targetId ? String(targetId) : null,
      });
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  /**
   * Procesa un comando de voz completo:
   * 1. Comprueba si es un comando global de navegador (historial, pestañas, scroll, búsqueda, URLs).
   * 2. Si no es global, extrae candidatos AOM podados del Child.
   * 3. Si está en modo vidente, muestra el overlay con badges.
   * 4. Despacha al demonio Rust para clasificar contra elementos en pantalla en <1ms.
   * 5. Ejecuta la acción en el nodo ganador con la variante sensorial configurada.
   * @param {string} transcript - Texto del comando de voz.
   */
  async processVoiceCommand(transcript) {
    const topWin = this.browsingContext?.topChromeWindow || Services.wm?.getMostRecentWindow("navigator:browser");

    const wasMuted = Services.zenVoiceNavButtonState === "muted";
    if (wasMuted) {
      if (/^(?:activar|reanudar|desmutear)\s+voz$/i.test(transcript.trim())) {
        return await executeGlobalVoiceCommand(transcript, topWin, this);
      }
      logDebug(`Comando ignorado en actor por estar silenciado: "${transcript}"`);
      return { handled: false, muted: true };
    }

    updateVoiceNavButtonState("processing");
    try {
      // 1. Prioridad: Comandos globales del navegador
      const globalRes = await executeGlobalVoiceCommand(transcript, topWin, this);
      if (globalRes && globalRes.handled) {
        return globalRes;
      }

      // 1.5. Acciones directas de formulario sin requerir candidatos previos (Enter, Submit, Limpiar campo)
      if (/^(?:(?:presionar|presiona|presione|pulsar|pulsa|pulse|dar|dale|hacer|haz)\s+)?enter$/i.test(transcript.trim())) {
        logDebug("Comando de formulario: Presionar enter");
        await this.pressEnter(null);
        showNativeChromeHUD(topWin, { success: true, transcript, label: "Enter", latencyMs: 0.05 });
        return { success: true, action: "press_enter" };
      }

      if (/^(?:enviar(?:\s+formulario)?|submit)$/i.test(transcript.trim())) {
        logDebug("Comando de formulario: Enviar formulario");
        await this.submitForm(null);
        showNativeChromeHUD(topWin, { success: true, transcript, label: "Enviar formulario", latencyMs: 0.05 });
        return { success: true, action: "submit_form" };
      }

      if (/^(?:borrar|borra|limpiar|limpia|vaciar|vacia)\s+campo$/i.test(transcript.trim())) {
        logDebug("Comando de formulario: Limpiar campo enfocado");
        await this.clearInput(null);
        showNativeChromeHUD(topWin, { success: true, transcript, label: "Campo borrado", latencyMs: 0.05 });
        return { success: true, action: "clear_input" };
      }

      const mode = getVoiceNavMode();
      logDebug(`Iniciando processVoiceCommand en página: "${transcript}", modo: ${mode}`);

    // 2. Obtener candidatos interactivos en la página
    let candidates = [];
    try {
      const candidatesRes = await this.getCandidates(true);
      candidates = candidatesRes?.candidates || [];
      logDebug(`getCandidates retornó ${candidates.length} elementos`);
    } catch (e) {
      logDebug(`Error en getCandidates: ${e}`);
    }

    // Helper de resolución de campos de entrada (por índice numérico o coincidencia léxica)
    function findInputTarget(query, list) {
      if (!query) return null;
      const clean = query.trim().toLowerCase().replace(/^(?:el\s+campo\s+|el\s+|la\s+|campo\s+)/i, "").trim();
      const num = parseNumericSelection(clean);
      if (num !== null && num >= 1 && num <= list.length) {
        return list[num - 1];
      }
      const inputs = list.filter(c => c.is_input || c.role_id === 3 || c.role?.includes("entry") || c.role?.includes("text") || c.role?.includes("input") || c.role?.includes("textarea"));
      const pool = inputs.length > 0 ? inputs : list;
      return pool.find(c => c.name && c.name.toLowerCase() === clean) ||
             pool.find(c => c.name && c.name.toLowerCase().includes(clean)) ||
             pool.find(c => c.description && c.description.toLowerCase().includes(clean)) ||
             pool.find(c => (c.placeholder || "").toLowerCase().includes(clean)) ||
             null;
    }

    // 2.0. Dictado Inteligente en Campos de Formulario (Imperativo y Natural)
    const DICT_VERBS = "(?:escribir|escribe|escriba|dictar|dicta|dicte|poner|pon|ponga|introducir|introduce|introduzca|tipear|tipea|teclear|teclea)";
    const fillWithMatch = transcript.match(/^(?:rellenar|rellena|rellene|llenar|llena|llene)\s+(?:el\s+campo\s+|el\s+|la\s+|campo\s+)?([a-z0-9ñáéíóú\s_-]+?)\s+con\s+(.+)$/i);
    const typeInEndMatch = transcript.match(new RegExp(`^${DICT_VERBS}\\s+(.+?)\\s+en\\s+(?:el\\s+campo\\s+|el\\s+|la\\s+|campo\\s+)?([a-z0-9ñáéíóú\\s_-]+)$`, "i"));
    const typeInMidMatch = transcript.match(new RegExp(`^${DICT_VERBS}\\s+en\\s+(?:el\\s+campo\\s+|el\\s+|la\\s+|campo\\s+)?([a-z0-9ñáéíóú\\s_-]+?)\\s+(.+)$`, "i"));
    const directVerbMatch = transcript.match(new RegExp(`^${DICT_VERBS}\\s+(.+)$`, "i"));

    let dictTarget = null;
    let textToType = null;
    let fieldQuery = "";

    if (fillWithMatch) {
      fieldQuery = fillWithMatch[1].trim();
      textToType = fillWithMatch[2].trim();
      dictTarget = findInputTarget(fieldQuery, candidates);
      if (!dictTarget) {
        try {
          const allRes = await this.getCandidates(false);
          dictTarget = findInputTarget(fieldQuery, allRes?.candidates || []);
        } catch (_) {}
      }
    } else if (typeInMidMatch) {
      fieldQuery = typeInMidMatch[1].trim();
      textToType = typeInMidMatch[2].trim();
      dictTarget = findInputTarget(fieldQuery, candidates);
      if (!dictTarget) {
        try {
          const allRes = await this.getCandidates(false);
          dictTarget = findInputTarget(fieldQuery, allRes?.candidates || []);
        } catch (_) {}
      }
    } else if (typeInEndMatch) {
      fieldQuery = typeInEndMatch[2].trim();
      textToType = typeInEndMatch[1].trim();
      dictTarget = findInputTarget(fieldQuery, candidates);
      if (!dictTarget) {
        try {
          const allRes = await this.getCandidates(false);
          dictTarget = findInputTarget(fieldQuery, allRes?.candidates || []);
        } catch (_) {}
      }
    } else if (directVerbMatch) {
      const rest = directVerbMatch[1].trim();

      const searchPool = [...candidates];
      try {
        const allRes = await this.getCandidates(false);
        const allList = allRes?.candidates || [];
        for (const ac of allList) {
          if (!searchPool.some(c => c.id === ac.id)) searchPool.push(ac);
        }
      } catch (_) {}

      // Intentar emparejar prefijos de campos conocidos (ej. "escribe mensaje hola", "escribe nombre juan")
      for (const c of searchPool) {
        const cname = (c.name || "").toLowerCase().trim();
        const tokens = [cname];
        if (cname.includes("búsqueda") || cname.includes("busqueda")) tokens.push("búsqueda", "busqueda");
        if (cname.includes("usuario") || cname.includes("nombre")) tokens.push("nombre", "usuario");
        if (cname.includes("correo") || cname.includes("email")) tokens.push("correo", "email");
        if (cname.includes("mensaje")) tokens.push("mensaje");

        for (const tok of tokens.filter(Boolean)) {
          if (rest.toLowerCase().startsWith(tok + " ")) {
            const potentialText = rest.slice(tok.length).trim();
            if (potentialText) {
              dictTarget = c;
              fieldQuery = tok;
              textToType = potentialText;
              break;
            }
          }
        }
        if (dictTarget) break;
      }

      if (!dictTarget) {
        // ¿Primera palabra es un campo o número? (ej. "escribe 4 gracias", "escribe mensaje hola")
        const spaceIdx = rest.indexOf(" ");
        if (spaceIdx > 0) {
          const firstWord = rest.slice(0, spaceIdx).trim();
          const found = findInputTarget(firstWord, searchPool);
          if (found) {
            dictTarget = found;
            fieldQuery = firstWord;
            textToType = rest.slice(spaceIdx + 1).trim();
          }
        }
      }

      // Si no emparejó ningún campo específico, es dictado directo en el elemento con foco
      if (!dictTarget && rest) {
        textToType = rest;
        dictTarget = null;
      }
    }

    if (textToType !== null) {
      if (dictTarget) {
        logDebug(`Dictado en campo: "${textToType}" -> ${dictTarget.name || dictTarget.role} (ID ${dictTarget.id})`);
        await this.setInputValue(dictTarget.id, textToType, false, false);
        showNativeChromeHUD(topWin, {
          success: true,
          transcript,
          label: `"${textToType}" en ${dictTarget.name || fieldQuery || "campo"}`,
          latencyMs: 0.05,
        });
        return {
          success: true,
          action: "dictation_field",
          targetId: dictTarget.id,
          fieldName: dictTarget.name,
          value: textToType,
        };
      } else {
        logDebug(`Dictado directo en foco: "${textToType}"`);
        await this.setInputValue(null, textToType, false, false);
        showNativeChromeHUD(topWin, {
          success: true,
          transcript,
          label: `Dictado: "${textToType}"`,
          latencyMs: 0.05,
        });
        return { success: true, action: "dictation_direct", value: textToType };
      }
    }

    const clearSpecificMatch = transcript.match(/^(?:borrar|borra|limpiar|limpia|vaciar|vacia)\s+(?:el\s+campo\s+|el\s+|la\s+|campo\s+)?([a-z0-9ñáéíóú\s_-]+)$/i);
    if (clearSpecificMatch && clearSpecificMatch[1]) {
      const fieldQuery = clearSpecificMatch[1].trim();
      let targetCandidate = findInputTarget(fieldQuery, candidates);
      if (!targetCandidate) {
        try {
          const allRes = await this.getCandidates(false);
          targetCandidate = findInputTarget(fieldQuery, allRes?.candidates || []);
        } catch (_) {}
      }
      if (targetCandidate) {
        logDebug(`Limpiar campo: ${targetCandidate.name || targetCandidate.role} (ID ${targetCandidate.id})`);
        await this.clearInput(targetCandidate.id);
        showNativeChromeHUD(topWin, {
          success: true,
          transcript,
          label: `Campo ${targetCandidate.name || ""} limpiado`,
          latencyMs: 0.05,
        });
        return { success: true, action: "clear_field", targetId: targetCandidate.id };
      }
    }

    if (candidates.length === 0) {
      logDebug(`Sin candidatos en pantalla. Abortando.`);
      showNativeChromeHUD(topWin, {
        success: false,
        transcript,
        label: "Sin elementos interactivos en pantalla",
      });
      try {
        this.sendAsyncMessage("ZenVoiceNav:LogCommand", {
          transcript,
          success: false,
          reason: "No hay elementos interactivos en pantalla",
        });
      } catch (_) {}
      return { success: false, reason: "No hay elementos accionables en pantalla" };
    }

    // 2.1. Atajo O(1) de Selección Numérica Directa (ej. "3", "el 2", "opción 4", "click 1")
    const selectedNumber = parseNumericSelection(transcript);
    if (selectedNumber !== null) {
      logDebug(`Atajo numérico detectado: #${selectedNumber}`);
      const targetIndex = selectedNumber - 1;
      if (targetIndex >= 0 && targetIndex < candidates.length) {
        const target = candidates[targetIndex];
        logDebug(`Atajo numérico O(1) resuelto: #${selectedNumber} -> ID ${target.id} (${target.name || target.role})`);

        showNativeChromeHUD(topWin, {
          success: true,
          transcript,
          label: `[#${selectedNumber}] ${target.name || target.role}`,
          latencyMs: 0.02,
        });

        try {
          this.sendAsyncMessage("ZenVoiceNav:LogCommand", {
            transcript,
            success: true,
            decision: {
              matched_id: target.id,
              action: "click",
              confidence: 1.0,
              latency_ms: 0.02,
            },
          });
        } catch (_) {}

        const actionResult = await this.executeAction(target.id, 0, mode);
        return {
          success: true,
          matchedId: target.id,
          action: "numeric_select",
          number: selectedNumber,
          confidence: 1.0,
          latencyMs: 0.02,
          actionResult,
        };
      } else {
        logDebug(`Número #${selectedNumber} fuera de rango (1 a ${candidates.length})`);
        showNativeChromeHUD(topWin, {
          success: false,
          transcript,
          label: `Número #${selectedNumber} fuera de rango (1-${candidates.length})`,
        });
        return {
          success: false,
          reason: `Número #${selectedNumber} fuera de rango (1-${candidates.length})`,
        };
      }
    }

    // 3. Si el modo visual está activo o el usuario encendió los badges, actualizarlos
    if (mode === "visual-overlay" || topWin?._zenVoiceNavOverlayActive) {
      await this.showVisualOverlay(candidates);
    }

    // 4. Consultar al motor en Rust
    logDebug(`Consultando clasificación al motor Rust...`);
    const engine = getVoiceEngineClient();
    const decision = await engine.classify(transcript, candidates, 10);
    logDebug(`Decisión de Rust: matched_id=${decision.matched_id}, action=${decision.action}, conf=${decision.confidence}`);

    // Notificar al Chrome HUD nativo y al Child
    showNativeChromeHUD(topWin, {
      success: !!decision.matched_id,
      transcript,
      label: decision.matched_id ? `Acción: ${decision.action}` : "Sin coincidencia en página",
      latencyMs: decision.latency_ms,
    });
    try {
      this.sendAsyncMessage("ZenVoiceNav:LogCommand", {
        transcript,
        success: !!decision.matched_id,
        decision,
      });
    } catch (_) {}

    // 5. Si requiere fallback a Sistema 2 (botón mudo), capturar recorte
    if (decision.fallback_to_vlm && decision.matched_id) {
      console.log("[ZenVoiceNavParent] Activando Sistema 2 para botón mudo ID:", decision.matched_id);
      const crop = await this.captureNodeCrop(decision.matched_id);
    }

    // 6. Ejecutar la acción si hubo un match con confianza suficiente
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
    } finally {
      updateVoiceNavButtonState(Services.zenVoiceNavButtonState === "muted" ? "muted" : "listening");
    }
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
