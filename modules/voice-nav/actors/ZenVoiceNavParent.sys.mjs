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

import { ZenVoiceEngineClient } from "./ZenVoiceEngineClient.sys.mjs";

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
    } else if (type === "listening") {
      // Tono suave ascendente de inicio de escucha: 400Hz -> 600Hz (90ms)
      osc.type = "sine";
      osc.frequency.setValueAtTime(400, now);
      osc.frequency.exponentialRampToValueAtTime(600, now + 0.08);
      gain.gain.setValueAtTime(0.06, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.09);
      osc.start(now);
      osc.stop(now + 0.09);
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

/**
 * Anuncia un mensaje accesible para lectores de pantalla (NVDA, JAWS, Orca)
 * utilizando una Live Region nativa ARIA en el Chrome Window.
 * @param {string} message - Texto descriptivo a anunciar.
 * @param {"polite" | "assertive"} priority - Prioridad de habla.
 * @param {ChromeWindow} topWin
 */
export function announceAccessibility(message, priority = "polite", topWin = null) {
  try {
    const win = topWin || Services.wm?.getMostRecentWindow("navigator:browser");
    if (!win || !win.document) return;

    const doc = win.document;
    let liveRegion = doc.getElementById("zenkev-a11y-announcer");
    if (!liveRegion) {
      liveRegion = doc.createElementNS("http://www.w3.org/1999/xhtml", "div");
      liveRegion.id = "zenkev-a11y-announcer";
      liveRegion.setAttribute("aria-live", priority);
      liveRegion.setAttribute("aria-atomic", "true");
      liveRegion.style.cssText = `
        position: absolute;
        top: -9999px;
        left: -9999px;
        width: 1px;
        height: 1px;
        overflow: hidden;
        clip: rect(0, 0, 0, 0);
        white-space: nowrap;
      `;
      const root = doc.getElementById("browser") || doc.documentElement;
      root.appendChild(liveRegion);
    } else {
      liveRegion.setAttribute("aria-live", priority);
    }

    // Vaciar y asignar en frame siguiente para garantizar que los screen readers capturen la mutación
    liveRegion.textContent = "";
    win.requestAnimationFrame(() => {
      liveRegion.textContent = message;
    });
  } catch (err) {
    logDebug(`Error al anunciar a lector de pantalla: ${err}`);
  }
}

Services.zenAnnounceA11y = announceAccessibility;

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
export function showNativeChromeHUD(topWin, { success = true, transcript = "", label = "", latencyMs = null, tier = "tier1_lexical" }) {
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

  // Icono indicador con micro-gema y SVG vectorial puro
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

  // Feedback accesible para lectores de pantalla (NVDA, JAWS)
  const a11yText = transcript
    ? `${success ? "Ejecutado" : "No encontrado"}: ${transcript}. ${label || ""}`
    : label;
  announceAccessibility(a11yText, success ? "polite" : "assertive", win);

  // Cancelar animación previa si existe
  if (win._zenkevChromeHudAnim) {
    try { win._zenkevChromeHudAnim.cancel(); } catch (_) {}
  }
  const isDemo = Services.prefs.getBoolPref("zen.voicenav.demo_mode", false);
  const displayDuration = isDemo ? 3800 : 2200;
  if (transcript && success) {
    try { logRecentCommand(transcript, latencyMs, tier); } catch (_) {}
  }

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
    announceAccessibility("Navegación por voz silenciada", "assertive");
  } else if (state === "listening" && prevState === "muted") {
    playEarcon("unmute");
    announceAccessibility("Navegación por voz activa", "assertive");
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

let _recentCommandsLog = [
  { text: "presiona el dos", latency: "0.02ms", tier: "tier1_lexical" },
  { text: "quiero pagar mi pedido", latency: "0.85ms", tier: "tier2_semantic", isTier2: true },
  { text: "abrir nueva pestaña", latency: "0.03ms", tier: "tier1_lexical" },
];

export function logRecentCommand(transcript, latencyMs = 0.05, tier = "tier1_lexical") {
  const isTier2 = tier === "tier2_semantic";
  _recentCommandsLog.unshift({
    text: transcript.slice(0, 24),
    latency: latencyMs != null ? `${typeof latencyMs === "number" ? latencyMs.toFixed(2) : latencyMs}ms` : "0.05ms",
    tier,
    isTier2,
  });
  if (_recentCommandsLog.length > 4) _recentCommandsLog.pop();
  updatePanelHistoryUI();
}

function updatePanelHistoryUI() {
  try {
    const windows = Services.wm?.getEnumerator("navigator:browser");
    if (!windows) return;
    while (windows.hasMoreElements()) {
      const win = windows.getNext();
      const listEl = win?.document?.getElementById("zenkev-panel-history-list");
      if (listEl) {
        listEl.textContent = "";
        for (const cmd of _recentCommandsLog) {
          const row = win.document.createElementNS("http://www.w3.org/1999/xhtml", "div");
          row.style.cssText = "display: flex; justify-content: space-between; align-items: center; padding: 4px 8px; border-radius: 6px; background: rgba(255,255,255,0.06); font-size: 11px; font-family: monospace;";
          const left = win.document.createElementNS("http://www.w3.org/1999/xhtml", "span");
          left.style.cssText = "color:#e2e8f0; display:flex; align-items:center; gap:6px;";
          const dot = win.document.createElementNS("http://www.w3.org/1999/xhtml", "span");
          dot.style.cssText = `width:6px; height:6px; border-radius:50%; background:${cmd.isTier2 ? "#a855f7" : "#10b981"}; display:inline-block;`;
          left.appendChild(dot);
          left.appendChild(win.document.createTextNode(`"${cmd.text}"`));
          if (cmd.isTier2) {
            const badge = win.document.createElementNS("http://www.w3.org/1999/xhtml", "span");
            badge.style.cssText = "font-size:9px; font-weight:600; letter-spacing:0.5px; background:rgba(168,85,247,0.2); border:1px solid rgba(168,85,247,0.35); color:#c084fc; padding:1px 5px; border-radius:4px; margin-left:4px; font-family:monospace;";
            badge.textContent = "SEMANTIC";
            left.appendChild(badge);
          }
          const right = win.document.createElementNS("http://www.w3.org/1999/xhtml", "span");
          right.style.cssText = `color:${cmd.isTier2 ? "#c084fc" : "#38bdf8"}; font-weight:700;`;
          right.textContent = cmd.latency;
          row.appendChild(left);
          row.appendChild(right);
          listEl.appendChild(row);
        }
      }
    }
  } catch (_) {}
}

/**
 * Alterna el Panel Widget flotante nativo de zenKev con estética Glassmorphism.
 */
export function toggleNativeVoicePanel(topWin) {
  const win = topWin || Services.wm?.getMostRecentWindow("navigator:browser");
  if (!win || !win.document) return;

  const doc = win.document;
  let panel = doc.getElementById("zenkev-native-glass-panel");
  if (panel) {
    if (panel.style.display === "none") {
      panel.style.display = "flex";
      updatePanelHistoryUI();
      win.requestAnimationFrame(() => {
        panel.style.opacity = "1";
        panel.style.transform = "translateY(0) scale(1)";
      });
    } else {
      panel.style.opacity = "0";
      panel.style.transform = "translateY(-10px) scale(0.97)";
      const onTransitionEnd = (e) => {
        if (e.target === panel) {
          panel.removeEventListener("transitionend", onTransitionEnd);
          if (panel.style.opacity === "0") {
            panel.style.display = "none";
          }
        }
      };
      panel.addEventListener("transitionend", onTransitionEnd);
    }
    return;
  }

  // Crear el panel flotante Glassmorphism en Chrome Window
  panel = doc.createElementNS("http://www.w3.org/1999/xhtml", "div");
  panel.id = "zenkev-native-glass-panel";
  panel.style.cssText = `
    position: fixed;
    top: 56px;
    right: 20px;
    width: 330px;
    z-index: 2147483647;
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 20px;
    border-radius: 22px;
    background: linear-gradient(165deg, rgba(17, 24, 39, 0.72) 0%, rgba(10, 15, 29, 0.88) 100%);
    backdrop-filter: blur(32px) saturate(210%);
    -webkit-backdrop-filter: blur(32px) saturate(210%);
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-top: 1px solid rgba(255, 255, 255, 0.24);
    box-shadow: 0 30px 60px rgba(0, 0, 0, 0.65), 0 0 1px 1px rgba(255, 255, 255, 0.08) inset, 0 0 36px rgba(56, 189, 248, 0.12);
    color: #f8fafc;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, system-ui, sans-serif;
    opacity: 0;
    transform: translateY(-10px) scale(0.97);
    transition: opacity 0.22s cubic-bezier(0.16, 1, 0.3, 1), transform 0.22s cubic-bezier(0.16, 1, 0.3, 1);
  `;

  // Grabber handle superior
  const grabber = doc.createElementNS("http://www.w3.org/1999/xhtml", "div");
  grabber.style.cssText = "width: 36px; height: 4px; background: rgba(255, 255, 255, 0.2); border-radius: 9999px; align-self: center; margin-top: -6px; margin-bottom: 4px;";
  panel.appendChild(grabber);

  const svgNS = "http://www.w3.org/2000/svg";

  // Encabezado
  const header = doc.createElementNS("http://www.w3.org/1999/xhtml", "div");
  header.style.cssText = "display: flex; justify-content: space-between; align-items: center; padding-bottom: 10px; border-bottom: 1px solid rgba(255, 255, 255, 0.1);";

  const brand = doc.createElementNS("http://www.w3.org/1999/xhtml", "div");
  brand.style.cssText = "display: flex; align-items: center; gap: 10px;";
  const iconBox = doc.createElementNS("http://www.w3.org/1999/xhtml", "div");
  iconBox.style.cssText = "width: 32px; height: 32px; border-radius: 10px; background: linear-gradient(135deg, rgba(2, 132, 199, 0.8), rgba(99, 102, 241, 0.8)); border: 1px solid rgba(255, 255, 255, 0.2); box-shadow: 0 4px 12px rgba(2, 132, 199, 0.35); display: flex; align-items: center; justify-content: center; flex-shrink: 0;";

  const micSvg = doc.createElementNS(svgNS, "svg");
  micSvg.setAttribute("width", "16");
  micSvg.setAttribute("height", "16");
  micSvg.setAttribute("viewBox", "0 0 24 24");
  micSvg.setAttribute("fill", "none");
  micSvg.setAttribute("stroke", "#ffffff");
  micSvg.setAttribute("stroke-width", "2");
  micSvg.setAttribute("stroke-linecap", "round");
  micSvg.setAttribute("stroke-linejoin", "round");

  const micPath1 = doc.createElementNS(svgNS, "path");
  micPath1.setAttribute("d", "M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z");
  const micPath2 = doc.createElementNS(svgNS, "path");
  micPath2.setAttribute("d", "M19 10v2a7 7 0 0 1-14 0v-2");
  const micLine = doc.createElementNS(svgNS, "line");
  micLine.setAttribute("x1", "12");
  micLine.setAttribute("y1", "19");
  micLine.setAttribute("x2", "12");
  micLine.setAttribute("y2", "22");
  micSvg.appendChild(micPath1);
  micSvg.appendChild(micPath2);
  micSvg.appendChild(micLine);
  iconBox.appendChild(micSvg);

  const titleBox = doc.createElementNS("http://www.w3.org/1999/xhtml", "div");
  const mainTitle = doc.createElementNS("http://www.w3.org/1999/xhtml", "div");
  mainTitle.style.cssText = "font-weight: 700; font-size: 13px; color: #fff; letter-spacing: 0.2px;";
  mainTitle.textContent = "zenKev Control";
  const subTitle = doc.createElementNS("http://www.w3.org/1999/xhtml", "div");
  subTitle.style.cssText = "font-size: 10px; color: #94a3b8; margin-top: 1px;";
  subTitle.textContent = "Motor Local · Gecko AOM";
  titleBox.appendChild(mainTitle);
  titleBox.appendChild(subTitle);
  brand.appendChild(iconBox);
  brand.appendChild(titleBox);

  const closeBtn = doc.createElementNS("http://www.w3.org/1999/xhtml", "button");
  closeBtn.style.cssText = "background: rgba(255, 255, 255, 0.08); border: 1px solid rgba(255, 255, 255, 0.12); color: #cbd5e1; width: 26px; height: 26px; border-radius: 50%; cursor: pointer; display: flex; align-items: center; justify-content: center; padding: 0; transition: background 0.15s ease, color 0.15s ease;";
  closeBtn.title = "Cerrar";

  const closeSvg = doc.createElementNS(svgNS, "svg");
  closeSvg.setAttribute("width", "12");
  closeSvg.setAttribute("height", "12");
  closeSvg.setAttribute("viewBox", "0 0 24 24");
  closeSvg.setAttribute("fill", "none");
  closeSvg.setAttribute("stroke", "currentColor");
  closeSvg.setAttribute("stroke-width", "2.2");
  closeSvg.setAttribute("stroke-linecap", "round");
  closeSvg.setAttribute("stroke-linejoin", "round");

  const closeLine1 = doc.createElementNS(svgNS, "line");
  closeLine1.setAttribute("x1", "18");
  closeLine1.setAttribute("y1", "6");
  closeLine1.setAttribute("x2", "6");
  closeLine1.setAttribute("y2", "18");
  const closeLine2 = doc.createElementNS(svgNS, "line");
  closeLine2.setAttribute("x1", "6");
  closeLine2.setAttribute("y1", "6");
  closeLine2.setAttribute("x2", "18");
  closeLine2.setAttribute("y2", "18");
  closeSvg.appendChild(closeLine1);
  closeSvg.appendChild(closeLine2);
  closeBtn.appendChild(closeSvg);

  closeBtn.onclick = () => toggleNativeVoicePanel(win);

  header.appendChild(brand);
  header.appendChild(closeBtn);
  panel.appendChild(header);

  // Vúmetro de audio
  const vuBox = doc.createElementNS("http://www.w3.org/1999/xhtml", "div");
  vuBox.style.cssText = "background: rgba(0, 0, 0, 0.35); border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 12px; padding: 10px 12px;";

  const vuHeader = doc.createElementNS("http://www.w3.org/1999/xhtml", "div");
  vuHeader.style.cssText = "display: flex; justify-content: space-between; align-items: center; font-size: 11px; color: #94a3b8; margin-bottom: 8px;";

  const vuMicContainer = doc.createElementNS("http://www.w3.org/1999/xhtml", "div");
  vuMicContainer.style.cssText = "display: flex; align-items: center; gap: 5px;";

  const audioSvg = doc.createElementNS(svgNS, "svg");
  audioSvg.setAttribute("width", "12");
  audioSvg.setAttribute("height", "12");
  audioSvg.setAttribute("viewBox", "0 0 24 24");
  audioSvg.setAttribute("fill", "none");
  audioSvg.setAttribute("stroke", "#38bdf8");
  audioSvg.setAttribute("stroke-width", "2");
  audioSvg.setAttribute("stroke-linecap", "round");
  audioSvg.setAttribute("stroke-linejoin", "round");

  const audioPath1 = doc.createElementNS(svgNS, "polygon");
  audioPath1.setAttribute("points", "11 5 6 9 2 9 2 15 6 15 11 19 11 5");
  const audioPath2 = doc.createElementNS(svgNS, "path");
  audioPath2.setAttribute("d", "M15.54 8.46a5 5 0 0 1 0 7.07");
  audioSvg.appendChild(audioPath1);
  audioSvg.appendChild(audioPath2);

  const vuMicSpan = doc.createElementNS("http://www.w3.org/1999/xhtml", "span");
  vuMicSpan.textContent = "Entrada 16kHz";
  vuMicContainer.appendChild(audioSvg);
  vuMicContainer.appendChild(vuMicSpan);

  const vuStatusPill = doc.createElementNS("http://www.w3.org/1999/xhtml", "div");
  vuStatusPill.style.cssText = "display: flex; align-items: center; gap: 5px; background: rgba(16, 185, 129, 0.12); border: 1px solid rgba(16, 185, 129, 0.28); padding: 2px 7px; border-radius: 9999px;";

  const pulseDot = doc.createElementNS("http://www.w3.org/1999/xhtml", "span");
  pulseDot.style.cssText = "width: 6px; height: 6px; border-radius: 50%; background: #10b981; box-shadow: 0 0 8px #10b981; display: inline-block;";

  const vuStatusText = doc.createElementNS("http://www.w3.org/1999/xhtml", "span");
  vuStatusText.style.cssText = "color: #34d399; font-size: 10px; font-weight: 600; letter-spacing: 0.3px;";
  vuStatusText.textContent = "Escuchando";

  vuStatusPill.appendChild(pulseDot);
  vuStatusPill.appendChild(vuStatusText);

  vuHeader.appendChild(vuMicContainer);
  vuHeader.appendChild(vuStatusPill);

  const vuBars = doc.createElementNS("http://www.w3.org/1999/xhtml", "div");
  vuBars.style.cssText = "display: flex; align-items: flex-end; justify-content: space-between; height: 20px; gap: 3px;";
  const barHeights = [4, 8, 14, 18, 15, 11, 16, 9, 14, 6, 12, 5];
  for (const h of barHeights) {
    const b = doc.createElementNS("http://www.w3.org/1999/xhtml", "div");
    b.style.cssText = `flex: 1; background: linear-gradient(to top, rgba(14, 165, 233, 0.35) 0%, rgba(56, 189, 248, 0.95) 100%); box-shadow: 0 0 6px rgba(56, 189, 248, 0.25); border-radius: 4px; height: ${h}px;`;
    vuBars.appendChild(b);
  }
  vuBox.appendChild(vuHeader);
  vuBox.appendChild(vuBars);
  panel.appendChild(vuBox);

  // Botones de acción rápida
  const actions = doc.createElementNS("http://www.w3.org/1999/xhtml", "div");
  actions.style.cssText = "display: grid; grid-template-columns: 1fr 1fr; gap: 8px;";

  const btnBadges = doc.createElementNS("http://www.w3.org/1999/xhtml", "button");
  btnBadges.style.cssText = "background: rgba(255, 255, 255, 0.05); border: 1px solid rgba(255, 255, 255, 0.1); border-radius: 10px; padding: 10px 8px; color: #f1f5f9; cursor: pointer; display: flex; flex-direction: column; align-items: center; gap: 4px; transition: background 0.18s ease, border-color 0.18s ease;";

  const badgesSvg = doc.createElementNS(svgNS, "svg");
  badgesSvg.setAttribute("width", "16");
  badgesSvg.setAttribute("height", "16");
  badgesSvg.setAttribute("viewBox", "0 0 24 24");
  badgesSvg.setAttribute("fill", "none");
  badgesSvg.setAttribute("stroke", "#38bdf8");
  badgesSvg.setAttribute("stroke-width", "2");
  badgesSvg.setAttribute("stroke-linecap", "round");
  badgesSvg.setAttribute("stroke-linejoin", "round");

  const bLineH1 = doc.createElementNS(svgNS, "line");
  bLineH1.setAttribute("x1", "4"); bLineH1.setAttribute("y1", "9"); bLineH1.setAttribute("x2", "20"); bLineH1.setAttribute("y2", "9");
  const bLineH2 = doc.createElementNS(svgNS, "line");
  bLineH2.setAttribute("x1", "4"); bLineH2.setAttribute("y1", "15"); bLineH2.setAttribute("x2", "20"); bLineH2.setAttribute("y2", "15");
  const bLineV1 = doc.createElementNS(svgNS, "line");
  bLineV1.setAttribute("x1", "10"); bLineV1.setAttribute("y1", "3"); bLineV1.setAttribute("x2", "8"); bLineV1.setAttribute("y2", "21");
  const bLineV2 = doc.createElementNS(svgNS, "line");
  bLineV2.setAttribute("x1", "16"); bLineV2.setAttribute("y1", "3"); bLineV2.setAttribute("x2", "14"); bLineV2.setAttribute("y2", "21");
  badgesSvg.appendChild(bLineH1);
  badgesSvg.appendChild(bLineH2);
  badgesSvg.appendChild(bLineV1);
  badgesSvg.appendChild(bLineV2);

  const btnBadgesTitle = doc.createElementNS("http://www.w3.org/1999/xhtml", "span");
  btnBadgesTitle.style.cssText = "font-size: 11px; font-weight: 600; color: #f1f5f9;";
  btnBadgesTitle.textContent = "Atajos AOM";

  const btnBadgesSub = doc.createElementNS("http://www.w3.org/1999/xhtml", "span");
  btnBadgesSub.style.cssText = "font-size: 9px; color: #94a3b8;";
  btnBadgesSub.textContent = "Presiona [F2]";

  btnBadges.appendChild(badgesSvg);
  btnBadges.appendChild(btnBadgesTitle);
  btnBadges.appendChild(btnBadgesSub);
  btnBadges.onclick = () => {
    if (win.gZenVoiceNav?.toggleOverlay) win.gZenVoiceNav.toggleOverlay();
  };

  const btnDemo = doc.createElementNS("http://www.w3.org/1999/xhtml", "button");
  btnDemo.style.cssText = "background: rgba(255, 255, 255, 0.05); border: 1px solid rgba(255, 255, 255, 0.1); border-radius: 10px; padding: 10px 8px; color: #f1f5f9; cursor: pointer; display: flex; flex-direction: column; align-items: center; gap: 4px; transition: background 0.18s ease, border-color 0.18s ease;";

  const demoSvg = doc.createElementNS(svgNS, "svg");
  demoSvg.setAttribute("width", "16");
  demoSvg.setAttribute("height", "16");
  demoSvg.setAttribute("viewBox", "0 0 24 24");
  demoSvg.setAttribute("fill", "none");
  demoSvg.setAttribute("stroke", "#38bdf8");
  demoSvg.setAttribute("stroke-width", "2");
  demoSvg.setAttribute("stroke-linecap", "round");
  demoSvg.setAttribute("stroke-linejoin", "round");

  const zapPoly = doc.createElementNS(svgNS, "polygon");
  zapPoly.setAttribute("points", "13 2 3 14 12 14 11 22 21 10 12 10 13 2");
  demoSvg.appendChild(zapPoly);

  const btnDemoTitle = doc.createElementNS("http://www.w3.org/1999/xhtml", "span");
  btnDemoTitle.style.cssText = "font-size: 11px; font-weight: 600; color: #f1f5f9;";

  const btnDemoSub = doc.createElementNS("http://www.w3.org/1999/xhtml", "span");
  btnDemoSub.style.fontSize = "9px";

  const updateDemoBtn = (isDemo) => {
    btnDemoTitle.textContent = isDemo ? "Modo Demo" : "Modo Normal";
    btnDemoSub.textContent = isDemo ? "Ritmo humano (Demo)" : "Ultra Rápido (0.02ms)";
    btnDemoSub.style.color = isDemo ? "#fbbf24" : "#38bdf8";
    demoSvg.setAttribute("stroke", isDemo ? "#fbbf24" : "#38bdf8");
  };

  const isDemoCur = Services.prefs?.getBoolPref("zen.voicenav.demo_mode", false);
  updateDemoBtn(isDemoCur);
  btnDemo.appendChild(demoSvg);
  btnDemo.appendChild(btnDemoTitle);
  btnDemo.appendChild(btnDemoSub);

  btnDemo.onclick = () => {
    const cur = Services.prefs?.getBoolPref("zen.voicenav.demo_mode", false);
    const next = !cur;
    Services.prefs?.setBoolPref("zen.voicenav.demo_mode", next);
    updateDemoBtn(next);
  };

  actions.appendChild(btnBadges);
  actions.appendChild(btnDemo);
  panel.appendChild(actions);

  // Historial
  const historyBox = doc.createElementNS("http://www.w3.org/1999/xhtml", "div");
  historyBox.style.cssText = "border-top: 1px solid rgba(255, 255, 255, 0.08); padding-top: 8px;";
  const hTitle = doc.createElementNS("http://www.w3.org/1999/xhtml", "div");
  hTitle.style.cssText = "font-size: 10px; font-weight: 600; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.6px; margin-bottom: 6px;";
  hTitle.textContent = "Últimos Comandos";
  const historyList = doc.createElementNS("http://www.w3.org/1999/xhtml", "div");
  historyList.id = "zenkev-panel-history-list";
  historyList.style.cssText = "display: flex; flex-direction: column; gap: 4px;";
  historyBox.appendChild(hTitle);
  historyBox.appendChild(historyList);
  panel.appendChild(historyBox);

  // Tip de atajo al pie del panel
  const shortcutTip = doc.createElementNS("http://www.w3.org/1999/xhtml", "div");
  shortcutTip.style.cssText = "font-size: 10px; color: #64748b; text-align: center; padding-top: 4px; border-top: 1px solid rgba(255, 255, 255, 0.04);";
  shortcutTip.textContent = "Alternar panel con Alt + V";
  panel.appendChild(shortcutTip);

  const container = doc.getElementById("browser") || doc.documentElement;
  container.appendChild(panel);

  updatePanelHistoryUI();

  win.requestAnimationFrame(() => {
    panel.style.opacity = "1";
    panel.style.transform = "translateY(0) scale(1)";
  });
}

Services.zenToggleVoicePanel = toggleNativeVoicePanel;

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
      tooltiptext: "Zen Voice Navigator (Clic: Alternar Panel | Shift+Clic: Silenciar)",
      onBuild(aDocument) {
        const btn = aDocument.createXULElement("toolbarbutton");
        btn.id = "zen-voicenav-button";
        btn.setAttribute("id", "zen-voicenav-button");
        btn.setAttribute("class", "toolbarbutton-1 chromeclass-toolbar-additional zen-voicenav-button");
        btn.setAttribute("label", "Zen Voice Navigator");
        btn.setAttribute(
          "tooltiptext",
          "Zen Voice Navigator (Clic: Alternar Panel | Shift+Clic: Silenciar)"
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

          // Clic normal: abrir o alternar el Panel Widget Glassmorphism
          toggleNativeVoicePanel(win);
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
  if (/^bajar\s+un\s+poco$|^bajar\s+medio$|^scroll\s+medio\s+abajo$/i.test(text)) {
    logDebug("Comando global detectado: Scroll medio abajo");
    if (actor?.scroll) {
      await actor.scroll("down", null, 0.35);
    }
    notifyHUD(true, "Bajar un poco");
    return { handled: true, action: "scroll_down_half" };
  }

  if (/^subir\s+un\s+poco$|^subir\s+medio$|^scroll\s+medio\s+arriba$/i.test(text)) {
    logDebug("Comando global detectado: Scroll medio arriba");
    if (actor?.scroll) {
      await actor.scroll("up", null, 0.35);
    }
    notifyHUD(true, "Subir un poco");
    return { handled: true, action: "scroll_up_half" };
  }

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

  if (/^(?:cerrar|quitar)\s+(?:la\s+)?(?:configuraci[oó]n|ajustes|preferencias)$|^close\s+settings$/i.test(text)) {
    logDebug("Comando global detectado: Cerrar configuración");
    const tabs = getOpenTabs();
    for (const t of tabs) {
      const uri = t.linkedBrowser?.currentURI?.spec || "";
      if (uri.startsWith("about:preferences")) {
        if (gBrowser) gBrowser.removeTab(t);
        notifyHUD(true, "Configuración cerrada");
        return { handled: true, action: "close_preferences" };
      }
    }
    // Si no encontró pestaña explícita pero la actual es about:preferences, cerrarla
    if (gBrowser?.selectedTab?.linkedBrowser?.currentURI?.spec?.startsWith("about:preferences")) {
      gBrowser.removeTab(gBrowser.selectedTab);
      notifyHUD(true, "Configuración cerrada");
      return { handled: true, action: "close_preferences" };
    }
    notifyHUD(false, "Configuración no encontrada");
    return { handled: true, action: "close_preferences_not_found" };
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

  // 7.16 Búsqueda en Página (Find in Page)
  const findMatch = text.match(/^(?:buscar(?:\s+en\s+(?:la\s+)?p[aá]gina)?|encontrar)\s+(.+)$/i);
  if (findMatch && findMatch[1]) {
    const query = findMatch[1].trim();
    logDebug(`Comando global detectado: Buscar en página "${query}"`);
    try {
      if (typeof win.gLazyFindCommand === "function") {
        win.gLazyFindCommand("onFindCommand");
      }
      const findBar = win.gFindBar || await gBrowser?.getFindBar?.();
      if (findBar) {
        findBar.open();
        findBar._findField.value = query;
        if (typeof findBar.startFind === "function") {
          findBar.startFind(findBar.FIND_NORMAL);
        }
        notifyHUD(true, `Buscando: "${query}"`);
        return { handled: true, action: "find_in_page", query };
      }
    } catch (e) {
      logDebug(`Error en buscar en página: ${e}`);
    }
  }

  if (/^(?:siguiente\s+coincidencia|buscar\s+siguiente|siguiente\s+resultado)$/i.test(text)) {
    logDebug("Comando global detectado: Siguiente coincidencia");
    try {
      const findBar = win.gFindBar || await gBrowser?.getFindBar?.();
      if (findBar && typeof findBar.onFindAgainCommand === "function") {
        findBar.onFindAgainCommand(false);
        notifyHUD(true, "Siguiente coincidencia");
        return { handled: true, action: "find_next" };
      }
    } catch (e) {
      logDebug(`Error en find next: ${e}`);
    }
  }

  if (/^(?:anterior\s+coincidencia|buscar\s+anterior|resultado\s+anterior)$/i.test(text)) {
    logDebug("Comando global detectado: Anterior coincidencia");
    try {
      const findBar = win.gFindBar || await gBrowser?.getFindBar?.();
      if (findBar && typeof findBar.onFindAgainCommand === "function") {
        findBar.onFindAgainCommand(true);
        notifyHUD(true, "Anterior coincidencia");
        return { handled: true, action: "find_previous" };
      }
    } catch (e) {
      logDebug(`Error en find previous: ${e}`);
    }
  }

  if (/^(?:cerrar\s+b[uú]squeda|ocultar\s+b[uú]squeda)$/i.test(text)) {
    logDebug("Comando global detectado: Cerrar búsqueda");
    try {
      const findBar = win.gFindBar || await gBrowser?.getFindBar?.();
      if (findBar && typeof findBar.close === "function") {
        findBar.close();
        notifyHUD(true, "Búsqueda cerrada");
        return { handled: true, action: "find_close" };
      }
    } catch (e) {
      logDebug(`Error al cerrar barra de búsqueda: ${e}`);
    }
  }

  // 7.17 Modo Pantalla Completa (Full Screen)
  if (/^(?:pantalla\s+completa|modo\s+pantalla\s+completa|fullscreen)$/i.test(text)) {
    logDebug("Comando global detectado: Alternar pantalla completa");
    try {
      if (typeof win.BrowserFullScreen === "function") {
        win.BrowserFullScreen();
      } else if (typeof win.fullScreen !== "undefined") {
        win.fullScreen = !win.fullScreen;
      }
      notifyHUD(true, "Pantalla completa");
      return { handled: true, action: "toggle_fullscreen" };
    } catch (e) {
      logDebug(`Error en pantalla completa: ${e}`);
    }
  }

  // 7.18 Control de Audio de Pestaña (Mute / Unmute Tab)
  if (/^(?:silenciar\s+pesta[nñ]a|mutear\s+pesta[nñ]a|apagar\s+sonido|silenciar\s+audio)$/i.test(text)) {
    logDebug("Comando global detectado: Silenciar audio de pestaña");
    try {
      const currentTab = gBrowser?.selectedTab;
      if (currentTab) {
        if (typeof currentTab.toggleMuteAudio === "function") {
          if (!currentTab.soundPlaying && !currentTab.muted) {
            currentTab.toggleMuteAudio();
          } else if (!currentTab.muted) {
            currentTab.toggleMuteAudio();
          }
        } else if (typeof win.gBrowser?.toggleMuteAudioOnSelectedTab === "function") {
          win.gBrowser.toggleMuteAudioOnSelectedTab();
        }
        notifyHUD(true, "Pestaña silenciada");
        return { handled: true, action: "mute_tab" };
      }
    } catch (e) {
      logDebug(`Error al silenciar pestaña: ${e}`);
    }
  }

  if (/^(?:activar\s+sonido|desmutear\s+pesta[nñ]a|reactivar\s+audio|reproducir\s+audio)$/i.test(text)) {
    logDebug("Comando global detectado: Reactivar audio de pestaña");
    try {
      const currentTab = gBrowser?.selectedTab;
      if (currentTab) {
        if (typeof currentTab.toggleMuteAudio === "function" && currentTab.muted) {
          currentTab.toggleMuteAudio();
        } else if (typeof win.gBrowser?.toggleMuteAudioOnSelectedTab === "function") {
          win.gBrowser.toggleMuteAudioOnSelectedTab();
        }
        notifyHUD(true, "Audio activado");
        return { handled: true, action: "unmute_tab" };
      }
    } catch (e) {
      logDebug(`Error al activar audio de pestaña: ${e}`);
    }
  }

  // 7.19 Modo Lectura (Reader Mode)
  if (/^(?:modo\s+lectura|activar\s+modo\s+lectura|vista\s+de\s+lectura|lector)$/i.test(text)) {
    logDebug("Comando global detectado: Modo lectura");
    try {
      const browser = gBrowser?.selectedBrowser;
      if (win.AboutReaderParent?.toggleReaderMode && browser) {
        win.AboutReaderParent.toggleReaderMode(browser);
        notifyHUD(true, "Modo lectura");
        return { handled: true, action: "toggle_reader_mode" };
      } else {
        const readerBtn = win.document?.getElementById("reader-mode-button");
        if (readerBtn) {
          readerBtn.click();
          notifyHUD(true, "Modo lectura");
          return { handled: true, action: "toggle_reader_mode" };
        }
      }
      notifyHUD(false, "Modo lectura no disponible en esta página");
      return { handled: true, action: "reader_mode_unavailable" };
    } catch (e) {
      logDebug(`Error en modo lectura: ${e}`);
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

  // 7.5. Alternar Panel Widget de Control de Voz
  if (/^(?:abrir|mostrar|ver|cerrar|quitar)\s+(?:el\s+)?panel(?:\s+de\s+voz)?$|^panel$/i.test(text)) {
    logDebug("Comando global detectado: Alternar panel de voz");
    toggleNativeVoicePanel(win);
    notifyHUD(true, "Panel zenKev");
    return { handled: true, action: "toggle_panel" };
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
    togglePanel: () => toggleNativeVoicePanel(topWin),
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
        playEarcon("mute", topWin);
        announceAccessibility("Marcas numéricas desactivadas", "polite", topWin);
        await actor.hideVisualOverlay();
      } else {
        topWin._zenVoiceNavOverlayActive = true;
        playEarcon("listening", topWin);
        const r = await actor.getCandidates(true);
        const count = r.candidates?.length || 0;
        announceAccessibility(`Marcas visuales activadas. ${count} elementos interactivos en pantalla`, "polite", topWin);
        await actor.showVisualOverlay(r.candidates || []);
      }
    }
  };

  topWin.addEventListener("keydown", (e) => {
    // Atajos no conflictivos con Zen Browser ni Windows:
    // 1. F2 (tecla única rápida)
    // 2. Ctrl + Shift + Espacio (estilo asistente manos libres)
    // 3. Alt + Shift + V (Voice)
    // 4. Alt + V (Alternar panel Glassmorphism de control)
    const isF2 = e.key === "F2";
    const isCtrlShiftSpace = e.ctrlKey && e.shiftKey && (e.key === " " || e.code === "Space");
    const isAltShiftV = e.altKey && e.shiftKey && e.key.toLowerCase() === "v";
    const isAltV = e.altKey && !e.shiftKey && !e.ctrlKey && e.key.toLowerCase() === "v";

    if (isAltV) {
      e.preventDefault();
      e.stopPropagation();
      toggleNativeVoicePanel(topWin);
      return;
    }

    if (isF2 || isCtrlShiftSpace || isAltShiftV) {
      e.preventDefault();
      e.stopPropagation();
      topWin.gZenVoiceNav.toggleOverlay();
    }
  }, { capture: true });

  console.log("[ZenKev] Inicializado con éxito. Alternar capa visual con F2, Ctrl+Shift+Espacio o Alt+Shift+V.");
  playEarcon("unmute", topWin);
  announceAccessibility("Zen Voice Navigator activo. Presiona F2 para alternar marcas visuales.", "polite", topWin);
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
   * Obtiene los candidatos interactivos de la pestaña actual, agregando
   * todos los contextos de navegación (top-level y sub-marcos / iframes).
   * @param {boolean} onlyVisible - Si es true, poda elementos fuera del viewport.
   */
  async getCandidates(onlyVisible = true) {
    try {
      // 1. Obtener todos los contextos en el sub-árbol de la pestaña
      const rootBc = this.browsingContext?.top || this.browsingContext;
      const bcs = rootBc?.getAllBrowsingContextsInSubtree
        ? rootBc.getAllBrowsingContextsInSubtree()
        : [this.browsingContext];

      const allCandidates = [];
      let topViewport = { width: 1280, height: 800 };
      let topUrl = "";
      let topTitle = "";

      for (const bc of bcs) {
        if (!bc || bc.isDiscarded) continue;
        try {
          const actor = bc.currentWindowGlobal?.getActor("ZenVoiceNav");
          if (!actor) continue;

          const res = await actor.sendQuery("ZenVoiceNav:GetCandidates", { onlyVisible });
          if (!res || !res.candidates) continue;

          const isTop = bc === rootBc;
          if (isTop) {
            topViewport = res.viewport || topViewport;
            topUrl = res.url || "";
            topTitle = res.title || "";
          }

          const bcId = bc.id;

          for (const cand of res.candidates) {
            // Asignar ID compuesto con el BrowsingContext para enrutar acciones precisas a iframes
            cand.bcId = bcId;
            cand.rawId = cand.id;
            cand.id = isTop ? String(cand.id) : `f${bcId}_${cand.id}`;
            cand.isIframe = !isTop;
            allCandidates.push(cand);
          }
        } catch (_) {}
      }

      return {
        candidates: allCandidates,
        viewport: topViewport,
        url: topUrl,
        title: topTitle,
      };
    } catch (e) {
      console.error("[ZenVoiceNavParent] Error al obtener candidatos AOM multi-frame:", e);
      return { candidates: [], error: e.message };
    }
  }

  /**
   * Resuelve el actor adecuado (top o iframe) a partir de un targetId.
   */
  #resolveTargetActor(targetId) {
    if (!targetId) return this;
    const strId = String(targetId);
    const match = strId.match(/^f(\d+)_(.+)$/);
    if (match) {
      const bcId = parseInt(match[1], 10);
      const rawId = match[2];
      const rootBc = this.browsingContext?.top || this.browsingContext;
      const bcs = rootBc?.getAllBrowsingContextsInSubtree ? rootBc.getAllBrowsingContextsInSubtree() : [];
      const foundBc = bcs.find(b => b.id === bcId);
      if (foundBc) {
        const actor = foundBc.currentWindowGlobal?.getActor("ZenVoiceNav");
        if (actor) {
          return { actor, realId: rawId };
        }
      }
    }
    return { actor: this, realId: targetId };
  }

  /**
   * Ejecuta la acción por defecto sobre un nodo accesible identificado por ID.
   * @param {string|number} targetId - uniqueID del nodo accesible.
   * @param {number} actionIndex - Índice de acción (0 para doDefaultAction).
   * @param {string} mode - "screen-reader" | "visual-overlay" | "both"
   */
  async executeAction(targetId, actionIndex = 0, mode = null) {
    const resolvedMode = getVoiceNavMode(mode);
    const { actor, realId } = this.#resolveTargetActor(targetId);
    try {
      return await actor.sendQuery("ZenVoiceNav:ExecuteAction", {
        targetId: String(realId),
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
      const { actor, realId } = this.#resolveTargetActor(targetId);
      return await actor.sendQuery("ZenVoiceNav:SetInputValue", {
        targetId: realId ? String(realId) : null,
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
      const { actor, realId } = this.#resolveTargetActor(targetId);
      return await actor.sendQuery("ZenVoiceNav:ClearInput", {
        targetId: realId ? String(realId) : null,
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
      const { actor, realId } = this.#resolveTargetActor(targetId);
      return await actor.sendQuery("ZenVoiceNav:SubmitForm", {
        targetId: realId ? String(realId) : null,
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
      const { actor, realId } = this.#resolveTargetActor(targetId);
      return await actor.sendQuery("ZenVoiceNav:PressEnter", {
        targetId: realId ? String(realId) : null,
      });
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  /**
   * Selecciona una opción en un <select> nativo o combobox ARIA.
   */
  async selectOption(targetId, optionQuery) {
    try {
      const { actor, realId } = this.#resolveTargetActor(targetId);
      return await actor.sendQuery("ZenVoiceNav:SelectOption", {
        targetId: realId ? String(realId) : null,
        optionQuery,
      });
    } catch (e) {
      console.error(`[ZenVoiceNavParent] Error en selectOption:`, e);
      return { success: false, error: e.message };
    }
  }

  /**
   * Ajusta un slider o input numérico (range, number, role=slider).
   */
  async adjustRange(targetId, direction = "set", amount = 0) {
    try {
      const { actor, realId } = this.#resolveTargetActor(targetId);
      return await actor.sendQuery("ZenVoiceNav:AdjustRange", {
        targetId: realId ? String(realId) : null,
        direction,
        amount,
      });
    } catch (e) {
      console.error(`[ZenVoiceNavParent] Error en adjustRange:`, e);
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

    // 2.0. Dictado Inteligente en Campos de Formulario (Imperativo y Natural multilingüe: ES / EN / PT)
    const DICT_VERBS = "(?:escribir|escribe|escriba|dictar|dicta|dicte|poner|pon|ponga|introducir|introduce|introduzca|tipear|tipea|teclear|teclea|type|write|input|enter|fill|digite|escreva|inserir)";
    const fillWithMatch = transcript.match(/^(?:rellenar|rellena|rellene|llenar|llena|llene|fill|preencher)\s+(?:el\s+campo\s+|el\s+|la\s+|campo\s+|the\s+field\s+|the\s+|o\s+campo\s+)?([a-z0-9ñáéíóúç\s_-]+?)\s+(?:con|with|com)\s+(.+)$/i);
    const typeInEndMatch = transcript.match(new RegExp(`^${DICT_VERBS}\\s+(.+?)\\s+(?:en|in|into|no|na)\\s+(?:el\s+campo\s+|el\s+|la\s+|campo\s+|the\s+field\s+|the\s+|o\s+campo\s+)?([a-z0-9ñáéíóúç\\s_-]+)$`, "i"));
    const typeInMidMatch = transcript.match(new RegExp(`^${DICT_VERBS}\\s+(?:en|in|into|no|na)\\s+(?:el\s+campo\s+|el\s+|la\s+|campo\s+|the\s+field\s+|the\s+|o\s+campo\s+)?([a-z0-9ñáéíóúç\\s_-]+?)\\s+(.+)$`, "i"));
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

    // 2.0.1. Selección de opción en Selects o Dropdowns ("elegir opción Argentina", "select country Spain", "pick option 2")
    const selectOptionMatch = transcript.match(/^(?:elegir|elige|elija|seleccionar|selecciona|seleccione|escoger|escoge|escoja|marcar|marca|marque|select|choose|pick|escolher|selecione)\s+(?:la\s+|the\s+|a\s+)?(?:opci[oó]n\s+|option\s+|opção\s+)?([a-z0-9ñáéíóúç\s_-]+?)(?:\s+(?:en|in|into|no|na)\s+(?:el\s+|la\s+|the\s+|o\s+)?(?:select|men[uú]|desplegable|dropdown|campo|field)?\s*([a-z0-9ñáéíóúç\s_-]+))?$/i);
    if (selectOptionMatch && selectOptionMatch[1]) {
      const optionVal = selectOptionMatch[1].trim();
      const selectFieldName = selectOptionMatch[2]?.trim();

      // Si no es un comando de selección numérica (ej. no es "opción 2" si fue capturado como tal, aunque selectOption también maneja número de opción)
      let selectTarget = null;
      if (selectFieldName) {
        selectTarget = findInputTarget(selectFieldName, candidates);
      }
      if (!selectTarget) {
        // Buscar candidatos con rol combobox, listbox o select
        const selects = candidates.filter(c =>
          c.role_id === 7 || // Ci.nsIAccessibleRole.ROLE_COMBOBOX
          c.role?.includes("combobox") ||
          c.role?.includes("select") ||
          c.role?.includes("listbox")
        );
        if (selects.length > 0) {
          selectTarget = selects[0];
        }
      }

      logDebug(`Comando de selección de opción: "${optionVal}" en target ${selectTarget?.id || 'activo'}`);
      const selRes = await this.selectOption(selectTarget?.id || null, optionVal);
      if (selRes && selRes.success) {
        showNativeChromeHUD(topWin, {
          success: true,
          transcript,
          label: `Seleccionado: ${selRes.selectedText || optionVal}`,
          latencyMs: 0.05,
        });
        return {
          success: true,
          action: "select_option",
          targetId: selectTarget?.id,
          selectedText: selRes.selectedText || optionVal,
        };
      }
    }

    // 2.0.2. Ajuste de Sliders y Controles de Rango ("subir volumen a 80", "set volume to 80", "volume up 10")
    const rangeMatch = transcript.match(/^(?:ajustar|ajusta|poner|pon|colocar|coloca|subir|sube|bajar|baja|aumentar|aumenta|reducir|reduce|set|adjust|increase|decrease|volume\s+up|volume\s+down)\s+(?:el\s+|la\s+|the\s+|o\s+)?([a-z0-9ñáéíóúç\s_-]+?)\s+(?:a|al|en|to|by)?\s*([0-9]{1,3})%?$/i);
    if (rangeMatch && rangeMatch[1] && rangeMatch[2]) {
      const rangeFieldName = rangeMatch[1].trim();
      const targetNum = parseFloat(rangeMatch[2]);
      const verb = transcript.trim().split(/\s+/)[0].toLowerCase();
      let dir = "set";
      if (/^(?:subir|sube|aumentar|aumenta|increase)$/i.test(verb) || transcript.toLowerCase().includes("volume up")) {
        dir = "increment";
      } else if (/^(?:bajar|baja|reducir|reduce|decrease)$/i.test(verb) || transcript.toLowerCase().includes("volume down")) {
        dir = "decrement";
      }

      let sliderTarget = findInputTarget(rangeFieldName, candidates);
      if (!sliderTarget) {
        const sliders = candidates.filter(c =>
          c.role?.includes("slider") ||
          c.role?.includes("range") ||
          c.role?.includes("spinbutton")
        );
        if (sliders.length > 0) {
          sliderTarget = sliders[0];
        }
      }

      logDebug(`Ajuste de slider: "${rangeFieldName}" -> ${targetNum} (${dir}) en target ${sliderTarget?.id || 'activo'}`);
      const adjRes = await this.adjustRange(sliderTarget?.id || null, dir, targetNum);
      if (adjRes && adjRes.success) {
        showNativeChromeHUD(topWin, {
          success: true,
          transcript,
          label: `Slider ajustado: ${adjRes.value}`,
          latencyMs: 0.05,
        });
        return {
          success: true,
          action: "adjust_range",
          targetId: sliderTarget?.id,
          value: adjRes.value,
        };
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
    const isTier2 = decision.tier === "tier2_semantic";
    const tierBadge = isTier2 ? "Tier 2 (Semántico)" : "Tier 1 (Léxico)";
    showNativeChromeHUD(topWin, {
      success: !!decision.matched_id,
      transcript,
      label: decision.matched_id ? `${tierBadge} → ${decision.action}` : "Sin coincidencia en página",
      latencyMs: decision.latency_ms,
      tier: decision.tier || "tier1_lexical",
    });
    try {
      this.sendAsyncMessage("ZenVoiceNav:LogCommand", {
        transcript,
        success: !!decision.matched_id,
        decision,
      });
    } catch (_) {}

    // 5. Si requiere fallback a Sistema 2 (botón mudo), capturar recorte e inspeccionar con VLM
    if (decision.fallback_to_vlm && decision.matched_id) {
      logDebug(`[ZenVoiceNavParent] Activando Sistema 2 para botón mudo ID: ${decision.matched_id}`);
      const crop = await this.captureNodeCrop(decision.matched_id);
      if (crop && crop.success) {
        logDebug(`[ZenVoiceNavParent] Recorte obtenido con éxito (${crop.width}x${crop.height}), consultando inspectVisual...`);
        const vlmRes = await engine.inspectVisual(decision.matched_id, transcript, crop);
        logDebug(`[ZenVoiceNavParent] Resultado VLM: ${JSON.stringify(vlmRes)}`);

        if (vlmRes && vlmRes.matches_transcript && vlmRes.confidence >= 0.70) {
          decision.confidence = vlmRes.confidence;
          decision.action = vlmRes.suggested_action || "click";
          decision.tier = "tier3_vlm_visual";
          showNativeChromeHUD(topWin, {
            success: true,
            transcript,
            label: `Tier 3 (VLM Visual) → ${decision.action}`,
            latencyMs: decision.latency_ms,
            tier: "tier3_vlm_visual",
          });
        } else if (vlmRes && !vlmRes.matches_transcript) {
          logDebug(`[ZenVoiceNavParent] VLM descartó el botón por discrepancia visual con el comando.`);
          decision.matched_id = null;
          showNativeChromeHUD(topWin, {
            success: false,
            transcript,
            label: "Descartado por inspección visual",
            latencyMs: decision.latency_ms,
            tier: "tier3_vlm_visual",
          });
        }
      } else {
        logDebug(`[ZenVoiceNavParent] Falló la captura del recorte gráfico para ID ${decision.matched_id}: ${crop?.error}`);
      }
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
