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

  // Limpiar temporizador previo
  if (win._zenkevChromeHudTimeout) {
    win.clearTimeout(win._zenkevChromeHudTimeout);
  }
  win._zenkevChromeHudTimeout = win.setTimeout(() => {
    if (hud) {
      hud.style.opacity = "0";
      hud.style.transform = "translateX(-50%) translateY(-14px)";
    }
  }, 2800);
}

// Exponer en Services para consumo global en Gecko
Services.zenShowVoiceHUD = showNativeChromeHUD;

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

  // 2. Control de Pestañas
  if (/^nueva\s+pesta[nñ]a$|^abrir\s+pesta[nñ]a$|^crear\s+pesta[nñ]a$/i.test(text)) {
    logDebug("Comando global detectado: Nueva pestaña");
    if (win.BrowserOpenTab) {
      win.BrowserOpenTab();
    } else if (gBrowser?.addTrustedTab) {
      gBrowser.addTrustedTab("about:newtab");
    }
    notifyHUD(true, "Nueva pestaña");
    return { handled: true, action: "new_tab" };
  }

  if (/^cerrar\s+(?:esta\s+)?pesta[nñ]a$|^quitar\s+pesta[nñ]a$/i.test(text)) {
    logDebug("Comando global detectado: Cerrar pestaña");
    if (gBrowser?.selectedTab) {
      gBrowser.removeTab(gBrowser.selectedTab);
    }
    notifyHUD(true, "Cerrar pestaña");
    return { handled: true, action: "close_tab" };
  }

  if (/^siguiente\s+pesta[nñ]a$|^pesta[nñ]a\s+siguiente$|^cambiar\s+pesta[nñ]a$/i.test(text)) {
    logDebug("Comando global detectado: Siguiente pestaña");
    if (gBrowser?.tabContainer?.advanceSelectedTab) {
      gBrowser.tabContainer.advanceSelectedTab(1, true);
    }
    notifyHUD(true, "Siguiente pestaña");
    return { handled: true, action: "next_tab" };
  }

  if (/^pesta[nñ]a\s+anterior$|^anterior\s+pesta[nñ]a$/i.test(text)) {
    logDebug("Comando global detectado: Pestaña anterior");
    if (gBrowser?.tabContainer?.advanceSelectedTab) {
      gBrowser.tabContainer.advanceSelectedTab(-1, true);
    }
    notifyHUD(true, "Pestaña anterior");
    return { handled: true, action: "previous_tab" };
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
  const searchMatch = text.match(/^(?:buscar|busca)(?:\s+en\s+google|\s+en\s+la\s+web)?\s+(.+)$/i);
  if (searchMatch && searchMatch[1]) {
    const query = searchMatch[1].trim();
    logDebug(`Comando global detectado: Búsqueda web para "${query}"`);
    const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}`;
    openUrlInBrowser(win, searchUrl);
    notifyHUD(true, `Búsqueda en Google: "${query}"`);
    return { handled: true, action: "web_search", query };
  }

  // 6. Modos Nativos de Zen y Firefox
  if (/^modo\s+lectura$|^activar\s+lectura$|^vista\s+lectura$/i.test(text)) {
    logDebug("Comando global detectado: Modo lectura");
    try {
      const browser = gBrowser?.selectedBrowser;
      if (browser) {
        if (win.AboutReaderParent?.toggleReaderMode) {
          win.AboutReaderParent.toggleReaderMode(browser);
        } else if (browser.toggleReaderMode) {
          browser.toggleReaderMode();
        }
      }
    } catch (_) {}
    notifyHUD(true, "Modo lectura");
    return { handled: true, action: "toggle_reader_mode" };
  }

  if (/^pantalla\s+completa$|^pantalla\s+entera$|^salir\s+de\s+pantalla\s+completa$/i.test(text)) {
    logDebug("Comando global detectado: Pantalla completa");
    if (typeof win.BrowserFullScreen === "function") {
      win.BrowserFullScreen();
    }
    notifyHUD(true, "Pantalla completa");
    return { handled: true, action: "toggle_fullscreen" };
  }

  if (/^duplicar\s+pesta[nñ]a$/i.test(text)) {
    logDebug("Comando global detectado: Duplicar pestaña");
    if (gBrowser?.duplicateTab && gBrowser?.selectedTab) {
      gBrowser.duplicateTab(gBrowser.selectedTab);
    }
    notifyHUD(true, "Duplicar pestaña");
    return { handled: true, action: "duplicate_tab" };
  }

  if (/^(?:silenciar|mutear)(?:\s+pesta[nñ]a)?$|^(?:activar|desmutear)\s+(?:sonido|audio)$/i.test(text)) {
    logDebug("Comando global detectado: Silenciar/Activar audio de pestaña");
    if (gBrowser?.selectedTab) {
      gBrowser.toggleMuteTab(gBrowser.selectedTab);
    }
    notifyHUD(true, "Audio de pestaña alternado");
    return { handled: true, action: "toggle_mute_tab" };
  }

  if (/^(?:abrir\s+)?descargas$/i.test(text)) {
    logDebug("Comando global detectado: Abrir descargas");
    if (typeof win.BrowserDownloadsUI === "function") {
      win.BrowserDownloadsUI();
    } else {
      openUrlInBrowser(win, "about:downloads");
    }
    notifyHUD(true, "Descargas");
    return { handled: true, action: "open_downloads" };
  }

  if (/^(?:abrir\s+)?historial$/i.test(text)) {
    logDebug("Comando global detectado: Abrir historial");
    openUrlInBrowser(win, "about:history");
    notifyHUD(true, "Historial");
    return { handled: true, action: "open_history" };
  }

  if (/^(?:abrir\s+)?configuraci[oó]n$|^(?:abrir\s+)?ajustes$/i.test(text)) {
    logDebug("Comando global detectado: Abrir configuración");
    if (typeof win.openPreferences === "function") {
      win.openPreferences();
    } else {
      openUrlInBrowser(win, "about:preferences");
    }
    notifyHUD(true, "Configuración");
    return { handled: true, action: "open_preferences" };
  }

  // 7. Ir a URL o Sitio Web (ej. "ir a wikipedia", "abrir youtube", "navegar a github.com")
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
    processCommand: async (transcript) => {
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
    
    // 1. Prioridad: Comandos globales del navegador
    const globalRes = await executeGlobalVoiceCommand(transcript, topWin, this);
    if (globalRes && globalRes.handled) {
      return globalRes;
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

    // 3. Si es modo visual, pintar los badges flotantes
    if (mode === "visual-overlay" || mode === "both") {
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
