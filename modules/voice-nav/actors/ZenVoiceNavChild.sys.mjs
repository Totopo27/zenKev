// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

/**
 * @file ZenVoiceNavChild.sys.mjs
 * Módulo de contenido (Content Process) encargado de:
 * 1. Inspeccionar el árbol AOM (nsIAccessibilityService) en el documento activo.
 * 2. Podar y filtrar nodos por roles accionables y visibilidad (viewport).
 * 3. Ejecutar acciones directas (doAction, takeFocus, etc.) sin emular eventos sintéticos.
 */

const Ci = Components.interfaces;
const Cc = Components.classes;

export class ZenVoiceNavChild extends JSWindowActorChild {
  #accService = null;
  #nodeCache = new Map(); // uniqueID (string) -> nsIAccessible

  // Límites de seguridad para evitar DoS y consumo excesivo en páginas anómalas
  static MAX_TRAVERSAL_NODES = 5000;
  static MAX_TRAVERSAL_DEPTH = 64;

  constructor() {
    super();
  }

  get accService() {
    if (!this.#accService) {
      this.#accService = Cc["@mozilla.org/accessibilityService;1"]
        ?.getService(Ci.nsIAccessibilityService);
    }
    return this.#accService;
  }

  /**
   * Manejador de eventos del ciclo de vida de la página.
   * Limpia el caché de nodos si el documento se descarga o navega.
   */
  handleEvent(event) {
    if (event.type === "DOMContentLoaded" || event.type === "pageshow") {
      try {
        this.sendAsyncMessage("ZenVoiceNav:Init", {});
      } catch (_) {}
    }
  }

  didDestroy() {
    this.#hideVisualOverlay();
    this.#nodeCache.clear();
    this.#accService = null;
  }

  /**
   * Manejador de mensajes IPC provenientes del proceso Padre (ZenVoiceNavParent).
   */
  async receiveMessage(message) {
    switch (message.name) {
      case "ZenVoiceNav:GetCandidates":
        return this.#collectCandidates(message.data?.onlyVisible ?? true);

      case "ZenVoiceNav:ExecuteAction":
        return this.#executeAction(
          message.data?.targetId,
          message.data?.actionIndex ?? 0,
          message.data?.mode ?? "screen-reader"
        );

      case "ZenVoiceNav:FocusTarget":
        return this.#focusTarget(
          message.data?.targetId,
          message.data?.mode ?? "screen-reader"
        );

      case "ZenVoiceNav:ShowVisualOverlay":
        return this.#showVisualOverlay(message.data?.candidates ?? []);

      case "ZenVoiceNav:HideVisualOverlay":
        return this.#hideVisualOverlay();

      case "ZenVoiceNav:CaptureNodeCrop":
        return this.#captureNodeCrop(message.data?.targetId);

      case "ZenVoiceNav:LogCommand": {
        const { transcript, success, decision, reason } = message.data || {};
        this.#displayVoiceFeedback(transcript, success, decision, reason);
        return { success: true };
      }

      case "ZenVoiceNav:ClearCache":
        this.#nodeCache.clear();
        return { success: true };

      default:
        return { error: `Mensaje desconocido: ${message.name}` };
    }
  }

  /**
   * Recolecta los elementos interactivos del documento actual usando AOM.
   */
  #collectCandidates(onlyVisible = true) {
    const doc = this.document;
    if (!doc) {
      return { candidates: [], error: "Documento no disponible" };
    }

    this.#nodeCache.clear();
    const candidates = [];

    const viewportWidth = this.contentWindow.innerWidth;
    const viewportHeight = this.contentWindow.innerHeight;

    let rootAcc = null;
    try {
      if (this.accService) {
        rootAcc = this.accService.getAccessibleFor(doc);
      }
    } catch (_) {}

    if (rootAcc) {
      this.#traverseAOM(rootAcc, (accNode) => {
        const role = accNode.role;
        if (!this.#isActionableRole(role)) {
          return;
        }

        // Obtener coordenadas en píxeles CSS para poda y para Sistema 2 (VLM)
        const bounds = this.#getNodeBounds(accNode);
        const isVisible = this.#isIntersectingViewport(bounds, viewportWidth, viewportHeight);

        if (onlyVisible && !isVisible) {
          return;
        }

        const id = accNode.uniqueID;
        this.#nodeCache.set(String(id), accNode);

        candidates.push({
          id: String(id),
          role_id: role,
          roleId: role,
          role: this.accService.getStringRole(role),
          name: accNode.name?.trim() || "",
          description: accNode.description?.trim() || "",
          bounds,
          is_visible: isVisible,
          isVisible,
          has_default_action: accNode.actionCount > 0,
          hasDefaultAction: accNode.actionCount > 0,
        });
      });
    }

    // Fallback híbrido: si AOM no devolvió candidatos, extraer directo de DOM
    if (candidates.length === 0 && doc.querySelectorAll) {
      const domElements = doc.querySelectorAll("button, a[href], input, select, textarea, [role='button'], [tabindex='0']");
      let domIdx = 1;
      for (const el of domElements) {
        const rect = el.getBoundingClientRect();
        const isVisible = rect.width > 0 && rect.height > 0 &&
                          rect.bottom >= 0 && rect.top <= viewportHeight &&
                          rect.right >= 0 && rect.left <= viewportWidth;
        if (onlyVisible && !isVisible) continue;

        const id = `dom-${domIdx++}`;
        const name = (el.innerText || el.value || el.getAttribute("aria-label") || el.title || el.placeholder || "").trim();
        const bounds = {
          x: Math.round(rect.left),
          y: Math.round(rect.top),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        };

        this.#nodeCache.set(id, el);

        candidates.push({
          id,
          role_id: 1,
          roleId: 1,
          role: el.tagName.toLowerCase(),
          name,
          description: el.getAttribute("aria-description") || "",
          bounds,
          is_visible: isVisible,
          isVisible,
          has_default_action: true,
          hasDefaultAction: true,
        });
      }
    }

    return {
      candidates,
      viewport: { width: viewportWidth, height: viewportHeight },
      url: doc.location?.href || "",
      title: doc.title || "",
    };
  }

  /**
   * Recorrido iterativo con pila explícita del árbol AOM.
   * Evita recursión profunda en la pila de SpiderMonkey (previene Stack Overflow)
   * y limita la cantidad máxima de nodos procesados para proteger el event loop.
   */
  #traverseAOM(rootNode, visitor) {
    if (!rootNode) return;

    // Pila de tuplas: [nodo, profundidad]
    const stack = [[rootNode, 0]];
    let processedCount = 0;

    while (stack.length > 0) {
      if (processedCount >= ZenVoiceNavChild.MAX_TRAVERSAL_NODES) {
        console.warn("[ZenVoiceNavChild] Se alcanzó el límite máximo de nodos AOM (" + ZenVoiceNavChild.MAX_TRAVERSAL_NODES + "). Poda preventiva activada.");
        break;
      }

      const [currentNode, depth] = stack.pop();
      processedCount++;

      try {
        visitor(currentNode);
      } catch (e) {
        // Ignorar errores puntuales en nodos inaccesibles
      }

      if (depth >= ZenVoiceNavChild.MAX_TRAVERSAL_DEPTH) {
        continue;
      }

      // Añadir hijos a la pila (en orden inverso para procesar de izquierda a derecha)
      const children = [];
      let child = currentNode.firstChild;
      while (child) {
        children.push(child);
        try {
          child = child.nextSibling;
        } catch (e) {
          break;
        }
      }

      for (let i = children.length - 1; i >= 0; i--) {
        stack.push([children[i], depth + 1]);
      }
    }
  }

  /**
   * Filtro de roles de accesibilidad accionables.
   */
  #isActionableRole(role) {
    switch (role) {
      case Ci.nsIAccessibleRole.ROLE_PUSHBUTTON:
      case Ci.nsIAccessibleRole.ROLE_LINK:
      case Ci.nsIAccessibleRole.ROLE_ENTRY:
      case Ci.nsIAccessibleRole.ROLE_CHECKBUTTON:
      case Ci.nsIAccessibleRole.ROLE_RADIOBUTTON:
      case Ci.nsIAccessibleRole.ROLE_COMBOBOX:
      case Ci.nsIAccessibleRole.ROLE_SLIDER:
      case Ci.nsIAccessibleRole.ROLE_SPINBUTTON:
      case Ci.nsIAccessibleRole.ROLE_PAGETAB:
      case Ci.nsIAccessibleRole.ROLE_MENUITEM:
      case Ci.nsIAccessibleRole.ROLE_CHECK_MENU_ITEM:
      case Ci.nsIAccessibleRole.ROLE_RADIO_MENU_ITEM:
      case Ci.nsIAccessibleRole.ROLE_SWITCH:
        return true;
      default:
        return false;
    }
  }

  /**
   * Extrae los límites (bounding box) de un nodo en píxeles CSS.
   */
  #getNodeBounds(accNode) {
    try {
      if (accNode.DOMNode && typeof accNode.DOMNode.getBoundingClientRect === "function") {
        const r = accNode.DOMNode.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) {
          return {
            x: Math.round(r.left),
            y: Math.round(r.top),
            width: Math.round(r.width),
            height: Math.round(r.height),
          };
        }
      }
    } catch (_) {}

    try {
      const x = {}, y = {}, width = {}, height = {};
      accNode.getBoundsInCSSPixels(x, y, width, height);
      return {
        x: x.value ?? 0,
        y: y.value ?? 0,
        width: width.value ?? 0,
        height: height.value ?? 0,
      };
    } catch (e) {
      return { x: 0, y: 0, width: 0, height: 0 };
    }
  }

  /**
   * Poda en origen: verifica si el elemento está dentro del viewport actual.
   */
  #isIntersectingViewport(bounds, vpWidth, vpHeight) {
    if (bounds.width <= 0 || bounds.height <= 0) {
      return false;
    }
    return (
      bounds.x < vpWidth &&
      bounds.x + bounds.width > 0 &&
      bounds.y < vpHeight &&
      bounds.y + bounds.height > 0
    );
  }

  /**
   * Ejecuta la acción por defecto del nodo accesible (ej. clic o activar).
   * Soporta variantes:
   * - "screen-reader": anuncia el cambio al lector de pantalla (NVDA/JAWS) vía accNode.announce.
   * - "visual-overlay": produce destello de highlight sobre el elemento sin TTS intrusivo.
   */
  #executeAction(targetId, actionIndex = 0, mode = "screen-reader") {
    const accNode = this.#nodeCache.get(String(targetId));
    if (!accNode) {
      return { success: false, error: `Nodo con ID ${targetId} no encontrado en caché` };
    }

    try {
      // Soporte para nodos DOM directos (fallback)
      if (accNode.click || (typeof accNode.focus === "function" && typeof accNode.getAttribute === "function")) {
        try { accNode.focus(); } catch (_) {}
        try { accNode.click(); } catch (_) {}
        if (mode === "visual-overlay" || mode === "both") {
          this.#highlightElement(accNode);
        }
        return { success: true, executedAction: "click" };
      }

      let executedAction = "takeFocus";
      if (accNode.actionCount > actionIndex) {
        executedAction = accNode.getActionName(actionIndex) || "action";
        accNode.doAction(actionIndex);
      } else {
        accNode.takeFocus();
      }

      // 1. Variante No Videntes: Notificación directa al lector de pantalla
      if (mode === "screen-reader" || mode === "both") {
        try {
          const actionText = `${executedAction}: ${accNode.name || "elemento"}`;
          accNode.announce(actionText, Ci.nsIAccessibleAnnouncementEvent.POLITE);
        } catch (_) {
          // Si announce falla en versiones antiguas de Gecko, takeFocus ya informa al lector
        }
      }

      // 2. Variante Videntes: Destello visual sobre el elemento DOM
      if (mode === "visual-overlay" || mode === "both") {
        this.#highlightElement(accNode.DOMNode);
      }

      return { success: true, executedAction };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  /**
   * Coloca el foco de accesibilidad en el elemento objetivo.
   */
  #focusTarget(targetId, mode = "screen-reader") {
    const accNode = this.#nodeCache.get(String(targetId));
    if (!accNode) {
      return { success: false, error: `Nodo con ID ${targetId} no encontrado en caché` };
    }

    try {
      accNode.takeFocus();

      if (mode === "screen-reader" || mode === "both") {
        try {
          const focusText = `Enfocado: ${accNode.name || accNode.role}`;
          accNode.announce(focusText, Ci.nsIAccessibleAnnouncementEvent.POLITE);
        } catch (_) {}
      }

      if (mode === "visual-overlay" || mode === "both") {
        this.#highlightElement(accNode.DOMNode);
      }

      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  /**
   * Variante Videntes: Muestra badges/etiquetas visuales sobre cada nodo candidato (estilo Vimium).
   */
  #showVisualOverlay(candidates) {
    this.#hideVisualOverlay();

    const doc = this.document;
    if (!doc || !doc.body) return { success: false, error: "DOM no disponible" };

    const container = doc.createElementNS("http://www.w3.org/1999/xhtml", "div");
    container.id = "zen-voicenav-overlay-container";
    container.setAttribute(
      "style",
      "position:fixed;top:0;left:0;width:100vw;height:100vh;pointer-events:none;z-index:2147483647;"
    );

    candidates.slice(0, 15).forEach((c, index) => {
      if (!c.bounds || c.bounds.width <= 0) return;
      const badge = doc.createElementNS("http://www.w3.org/1999/xhtml", "div");
      badge.textContent = `${index + 1}: ${c.name || c.role}`.slice(0, 20);
      badge.setAttribute(
        "style",
        `position:absolute;left:${Math.max(0, c.bounds.x)}px;top:${Math.max(0, c.bounds.y - 18)}px;` +
          `background:#0969da;color:#ffffff;font-size:11px;font-family:monospace;font-weight:bold;` +
          `padding:1px 5px;border-radius:3px;box-shadow:0 1px 3px rgba(0,0,0,0.3);pointer-events:none;`
      );
      container.appendChild(badge);
    });

    doc.body.appendChild(container);
    return { success: true, count: container.children.length };
  }

  /**
   * Variante Videntes: Oculta y limpia el overlay de badges.
   */
  #hideVisualOverlay() {
    const doc = this.document;
    if (!doc) return { success: true };
    const existing = doc.getElementById("zen-voicenav-overlay-container");
    if (existing) {
      existing.remove();
    }
    return { success: true };
  }

  /**
   * Variante Videntes: Destello visual (pulse ring) de 400ms sobre el elemento activado.
   */
  #highlightElement(domNode) {
    if (!domNode || !(domNode instanceof this.contentWindow.Element)) return;
    const prevOutline = domNode.style.outline;
    const prevTransition = domNode.style.transition;

    domNode.style.transition = "outline 0.15s ease-in-out";
    domNode.style.outline = "3px solid #0969da";

    this.contentWindow.setTimeout(() => {
      try {
        domNode.style.outline = prevOutline;
        domNode.style.transition = prevTransition;
      } catch (_) {}
    }, 400);
  }

  /**
   * Muestra feedback visual inmediato (HUD flotante + terminal de página) ante cualquier voz reconocida.
   */
  #displayVoiceFeedback(transcript, success, decision, reason) {
    const doc = this.document;
    if (!doc) return;

    // 1. Si existe #event-log en la página, añadir entrada al terminal interactivo
    const logEl = doc.getElementById("event-log");
    if (logEl) {
      const time = new Date().toLocaleTimeString();
      const statusIcon = success ? "✅" : "⚠️";
      const latencyStr = decision?.latency_ms ? ` (${decision.latency_ms.toFixed(2)}ms)` : "";
      const targetLabel = decision?.matched_id 
        ? `Coincidencia ID #${decision.matched_id} -> Acción: ${decision.action}${latencyStr}`
        : (reason || 'No coincide con botones en pantalla (prueba: "inicio", "guardar cambios", "configuración", "wikipedia")');
      logEl.textContent = `[${time}] ${statusIcon} Voz: "${transcript}" -> ${targetLabel}\n` + logEl.textContent;
    }

    // 2. Floating HUD Toast en la esquina superior derecha de la ventana
    let hud = doc.getElementById("zenkev-voice-hud");
    if (!hud) {
      hud = doc.createElement("div");
      hud.id = "zenkev-voice-hud";
      hud.style.cssText = `
        position: fixed;
        top: 24px;
        right: 24px;
        z-index: 2147483647;
        background: rgba(15, 23, 42, 0.95);
        color: #f8fafc;
        border-radius: 10px;
        padding: 12px 18px;
        font-family: system-ui, -apple-system, sans-serif;
        font-size: 14px;
        box-shadow: 0 10px 25px rgba(0,0,0,0.5);
        display: flex;
        align-items: center;
        gap: 12px;
        transition: opacity 0.3s ease;
        pointer-events: none;
      `;
      doc.body?.appendChild(hud);
    }

    hud.style.border = `2px solid ${success ? '#10b981' : '#f59e0b'}`;
    hud.innerHTML = `
      <span style="font-size: 22px;">${success ? '🎯' : '🎤'}</span>
      <div>
        <div style="font-weight: 700; color: #fff;">Voz: "${transcript}"</div>
        <div style="font-size: 12px; color: ${success ? '#34d399' : '#fbbf24'};">
          ${success ? `Acción ejecutada (${decision?.latency_ms?.toFixed(1) || 0}ms)` : 'Sin coincidencia (prueba: "guardar", "inicio", "wikipedia")'}
        </div>
      </div>
    `;

    hud.style.opacity = "1";
    this.contentWindow.clearTimeout(this._hudTimeout);
    this._hudTimeout = this.contentWindow.setTimeout(() => {
      if (hud) hud.style.opacity = "0";
    }, 4000);
  }

  /**
   * Sistema 2 (Contingencia Multimodal):
   * Captura un recorte acotado (máx 128x128 px) del nodo objetivo utilizando un canvas offscreen.
   * Evita screenshots de pantalla completa protegiendo la privacidad y reduciendo la carga en memoria.
   */
  #captureNodeCrop(targetId) {
    const accNode = this.#nodeCache.get(String(targetId));
    if (!accNode) {
      return { success: false, error: `Nodo con ID ${targetId} no encontrado` };
    }

    try {
      const domNode = accNode.DOMNode;
      if (!domNode || !(domNode instanceof this.contentWindow.Element)) {
        return { success: false, error: "Nodo DOM no disponible para renderizado gráfico" };
      }

      const rect = domNode.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) {
        return { success: false, error: "Dimensiones de nodo inválidas" };
      }

      // Limitar dimensiones del canvas a 128x128 px para SmolVLM/Moondream
      const targetWidth = Math.min(Math.round(rect.width), 128);
      const targetHeight = Math.min(Math.round(rect.height), 128);

      const canvas = this.document.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
      canvas.width = targetWidth;
      canvas.height = targetHeight;
      const ctx = canvas.getContext("2d");

      if (!ctx) {
        return { success: false, error: "No se pudo obtener el contexto 2D del canvas" };
      }

      // Dibujar la porción del elemento usando drawWindow nativo de Gecko si está disponible,
      // o renderizado SVG/DOM acotado
      if (typeof ctx.drawWindow === "function") {
        ctx.drawWindow(
          this.contentWindow,
          rect.left,
          rect.top,
          rect.width,
          rect.height,
          "rgba(0,0,0,0)"
        );
      }

      const dataUrl = canvas.toDataURL("image/png");

      return {
        success: true,
        targetId,
        width: targetWidth,
        height: targetHeight,
        dataUrl, // Payload PNG base64 acotado
      };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }
}
