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
    if (this._hudTimeout && this.contentWindow) {
      try {
        this.contentWindow.clearTimeout(this._hudTimeout);
      } catch (_) {}
      this._hudTimeout = null;
    }
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

      case "ZenVoiceNav:Scroll": {
        const { direction, amount, fraction } = message.data || {};
        const win = this.contentWindow;
        if (!win) return { success: false };

        const scrollAmount = amount || (fraction ? Math.round(win.innerHeight * fraction) : Math.round(win.innerHeight * 0.7));

        if (direction === "down") {
          win.scrollBy({ top: scrollAmount, left: 0, behavior: "smooth" });
        } else if (direction === "up") {
          win.scrollBy({ top: -scrollAmount, left: 0, behavior: "smooth" });
        } else if (direction === "top") {
          win.scrollTo({ top: 0, left: 0, behavior: "smooth" });
        } else if (direction === "bottom") {
          win.scrollTo({ top: win.document.documentElement.scrollHeight, left: 0, behavior: "smooth" });
        }
        return { success: true };
      }

      case "ZenVoiceNav:ClearCache":
        this.#nodeCache.clear();
        return { success: true };

      case "ZenVoiceNav:SetInputValue":
        return await this.#setInputValue(
          message.data?.targetId,
          message.data?.value ?? "",
          message.data?.append ?? false,
          message.data?.submit ?? false,
          message.data?.typewriter ?? false
        );

      case "ZenVoiceNav:ClearInput":
        return this.#clearInput(message.data?.targetId);

      case "ZenVoiceNav:SubmitForm":
        return this.#submitForm(message.data?.targetId);

      case "ZenVoiceNav:PressEnter":
        return this.#pressEnter(message.data?.targetId);

      case "ZenVoiceNav:SelectOption":
        return this.#selectOption(
          message.data?.targetId,
          message.data?.optionQuery ?? ""
        );

      case "ZenVoiceNav:AdjustRange":
        return this.#adjustRange(
          message.data?.targetId,
          message.data?.direction ?? "set",
          message.data?.amount ?? 0
        );

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
          const tag = accNode.DOMNode?.tagName?.toUpperCase();
          if (tag !== "TEXTAREA" && tag !== "INPUT" && tag !== "BUTTON" && tag !== "SELECT" && !accNode.DOMNode?.isContentEditable) {
            return;
          }
        }

        // Obtener coordenadas en píxeles CSS para poda y para Sistema 2 (VLM)
        const bounds = this.#getNodeBounds(accNode);
        const isVisible = this.#isIntersectingViewport(bounds, viewportWidth, viewportHeight);

        if (onlyVisible && !isVisible) {
          return;
        }

        const id = accNode.uniqueID;
        this.#nodeCache.set(String(id), accNode);

        let candidateName = accNode.name?.trim() || "";
        let isInput = role === Ci.nsIAccessibleRole.ROLE_ENTRY;
        if (accNode.DOMNode) {
          const d = accNode.DOMNode;
          const tag = d.tagName?.toUpperCase();
          if (tag === "INPUT" || tag === "TEXTAREA" || d.isContentEditable || d.getAttribute?.("role") === "textbox") {
            isInput = true;
          }
          if (!candidateName && d.placeholder) candidateName = d.placeholder.trim();
          if (!candidateName && d.labels && d.labels.length > 0) candidateName = d.labels[0].textContent?.trim() || "";
          if (!candidateName && d.id) {
            try {
              const lbl = doc.querySelector(`label[for="${CSS.escape(d.id)}"]`);
              if (lbl) candidateName = lbl.textContent?.trim() || "";
            } catch (_) {}
          }
          if (!candidateName && d.getAttribute?.("aria-label")) candidateName = d.getAttribute("aria-label").trim();
          if (!candidateName && d.name) candidateName = d.name.trim();
        }

        candidates.push({
          id: String(id),
          role_id: role,
          role: this.accService.getStringRole(role),
          name: candidateName,
          description: accNode.description?.trim() || "",
          bounds,
          is_visible: isVisible,
          is_input: isInput,
          has_default_action: accNode.actionCount > 0,
        });
      });
    }

    // Fallback híbrido: si AOM no devolvió candidatos, extraer directo de DOM
    if (candidates.length === 0 && doc.querySelectorAll) {
      const domElements = doc.querySelectorAll("button, a[href], input, select, textarea, [role='button'], [role='textbox'], [contenteditable='true'], [tabindex='0']");
      let domIdx = 1;
      for (const el of domElements) {
        const rect = el.getBoundingClientRect();
        const isVisible = rect.width > 0 && rect.height > 0 &&
                          rect.bottom >= 0 && rect.top <= viewportHeight &&
                          rect.right >= 0 && rect.left <= viewportWidth;
        if (onlyVisible && !isVisible) continue;

        const id = `dom-${domIdx++}`;
        const tag = el.tagName.toUpperCase();
        const isInput = tag === "INPUT" || tag === "TEXTAREA" || el.isContentEditable || el.getAttribute("role") === "textbox";
        let name = (el.innerText || el.value || el.getAttribute("aria-label") || el.title || el.placeholder || "").trim();
        if (!name && el.labels && el.labels.length > 0) name = el.labels[0].textContent?.trim() || "";
        if (!name && el.id) {
          try {
            const lbl = doc.querySelector(`label[for="${CSS.escape(el.id)}"]`);
            if (lbl) name = lbl.textContent?.trim() || "";
          } catch (_) {}
        }
        if (!name && el.name) name = el.name.trim();

        const bounds = {
          x: Math.round(rect.left),
          y: Math.round(rect.top),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        };

        this.#nodeCache.set(id, el);

        candidates.push({
          id,
          role_id: isInput ? 3 : 1,
          role: el.tagName.toLowerCase(),
          name,
          description: el.getAttribute("aria-description") || "",
          bounds,
          is_visible: isVisible,
          is_input: isInput,
          has_default_action: true,
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
      case Ci.nsIAccessibleRole.ROLE_TEXT_CONTAINER:
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
      case Ci.nsIAccessibleRole.ROLE_LISTITEM:
      case Ci.nsIAccessibleRole.ROLE_OPTION:
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
   * Dictado Inteligente: escribe o concatena texto en un campo de entrada o elemento editable.
   * Dispara eventos input y change compatibles con React, Vue, Angular y Vanilla JS.
   */
  async #setInputValue(targetId, value, append = false, submit = false, typewriter = false) {
    let el = null;
    if (targetId) {
      const cached = this.#nodeCache.get(String(targetId));
      el = cached?.DOMNode || cached;
    }
    if (!el && this.document?.activeElement && this.document.activeElement !== this.document.body) {
      el = this.document.activeElement;
    }
    if (!el) {
      // Fallback al primer input o textarea visible
      el = this.document?.querySelector("input:not([type='hidden']):not([disabled]), textarea:not([disabled]), [contenteditable='true']");
    }
    if (!el) {
      return { success: false, error: "No se encontró campo de texto ni elemento enfocado" };
    }

    try {
      el.focus();
      this.#highlightElement(el);

      const tag = el.tagName?.toUpperCase();
      const inputType = el.getAttribute?.("type")?.toLowerCase() || "";

      // Manejo inteligente de Fechas en HTML5 (<input type="date"> o <input type="datetime-local">)
      if (tag === "INPUT" && (inputType === "date" || inputType === "datetime-local" || inputType === "month")) {
        const parsedDate = this.#parseSpanishDate(value);
        if (parsedDate) {
          value = parsedDate;
        }
      }

      if (el.isContentEditable) {
        if (append) {
          el.textContent = (el.textContent ? el.textContent + " " : "") + value;
        } else {
          el.textContent = value;
        }
        el.dispatchEvent(new this.contentWindow.Event("input", { bubbles: true, cancelable: true }));
        el.dispatchEvent(new this.contentWindow.Event("change", { bubbles: true, cancelable: true }));
      } else {
        const proto = Object.getPrototypeOf(el);
        const desc = Object.getOwnPropertyDescriptor(proto, "value");
        const startVal = append && el.value ? `${el.value} ` : "";

        if (typewriter && value && value.length > 0) {
          for (let i = 1; i <= value.length; i++) {
            const curVal = startVal + value.slice(0, i);
            if (desc && desc.set) {
              desc.set.call(el, curVal);
            } else {
              el.value = curVal;
            }
            el.dispatchEvent(new this.contentWindow.Event("input", { bubbles: true, cancelable: true }));
            if (i < value.length) {
              await new Promise(r => this.contentWindow.requestAnimationFrame(r));
            }
          }
          el.dispatchEvent(new this.contentWindow.Event("change", { bubbles: true, cancelable: true }));
        } else {
          const finalValue = append && el.value ? `${el.value} ${value}` : value;
          if (desc && desc.set) {
            desc.set.call(el, finalValue);
          } else {
            el.value = finalValue;
          }
          el.dispatchEvent(new this.contentWindow.Event("input", { bubbles: true, cancelable: true }));
          el.dispatchEvent(new this.contentWindow.Event("change", { bubbles: true, cancelable: true }));
        }
      }

      if (submit && el.form) {
        if (typewriter) {
          await new Promise(r => this.contentWindow.requestAnimationFrame(r));
        }
        try {
          if (typeof el.form.requestSubmit === "function") {
            el.form.requestSubmit();
          } else {
            el.form.submit();
          }
        } catch (_) {}
      }

      return { success: true, targetId, value };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  /**
   * Limpia el contenido de un campo de texto o editable.
   */
  #clearInput(targetId) {
    let el = null;
    if (targetId) {
      const cached = this.#nodeCache.get(String(targetId));
      el = cached?.DOMNode || cached;
    }
    if (!el && this.document?.activeElement && this.document.activeElement !== this.document.body) {
      el = this.document.activeElement;
    }
    if (!el) {
      return { success: false, error: "No se encontró campo para limpiar" };
    }

    try {
      el.focus();
      if (el.isContentEditable) {
        el.textContent = "";
        el.dispatchEvent(new this.contentWindow.Event("input", { bubbles: true, cancelable: true }));
        el.dispatchEvent(new this.contentWindow.Event("change", { bubbles: true, cancelable: true }));
      } else {
        const proto = Object.getPrototypeOf(el);
        const desc = Object.getOwnPropertyDescriptor(proto, "value");
        if (desc && desc.set) {
          desc.set.call(el, "");
        } else {
          el.value = "";
        }
        el.dispatchEvent(new this.contentWindow.Event("input", { bubbles: true, cancelable: true }));
        el.dispatchEvent(new this.contentWindow.Event("change", { bubbles: true, cancelable: true }));
      }
      this.#highlightElement(el);
      return { success: true, targetId };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  /**
   * Envía el formulario asociado al campo o al documento activo.
   */
  #submitForm(targetId) {
    let el = null;
    if (targetId) {
      const cached = this.#nodeCache.get(String(targetId));
      el = cached?.DOMNode || cached;
    }
    if (!el && this.document?.activeElement) {
      el = this.document.activeElement;
    }
    const form = el?.form || this.document?.querySelector("form");
    if (!form) {
      return this.#pressEnter(targetId);
    }

    try {
      if (typeof form.requestSubmit === "function") {
        form.requestSubmit();
      } else {
        form.submit();
      }
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  /**
   * Simula la pulsación de la tecla Enter.
   */
  #pressEnter(targetId) {
    let el = null;
    if (targetId) {
      const cached = this.#nodeCache.get(String(targetId));
      el = cached?.DOMNode || cached;
    }
    if (!el && this.document?.activeElement) {
      el = this.document.activeElement;
    }
    if (!el) el = this.document?.body;
    if (!el) return { success: false, error: "No hay elemento disponible para enter" };

    try {
      const evOpts = { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true };
      el.dispatchEvent(new this.contentWindow.KeyboardEvent("keydown", evOpts));
      el.dispatchEvent(new this.contentWindow.KeyboardEvent("keypress", evOpts));
      el.dispatchEvent(new this.contentWindow.KeyboardEvent("keyup", evOpts));
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  /**
   * Parsea expresiones de fecha en lenguaje natural (ej. "15 de marzo de 2026", "hoy", "mañana", "2026-03-15")
   * y devuelve el formato estándar ISO YYYY-MM-DD para <input type="date">.
   */
  #parseSpanishDate(text) {
    if (!text || typeof text !== "string") return null;
    const clean = text.trim().toLowerCase();

    // Si ya viene en formato YYYY-MM-DD
    if (/^\d{4}-\d{2}-\d{2}$/.test(clean)) {
      return clean;
    }

    const today = new Date();
    if (clean === "hoy" || clean === "today" || clean === "hoje") {
      return today.toISOString().split("T")[0];
    }
    if (clean === "mañana" || clean === "manana" || clean === "tomorrow" || clean === "amanhã" || clean === "amanha") {
      const tomorrow = new Date(today);
      tomorrow.setDate(tomorrow.getDate() + 1);
      return tomorrow.toISOString().split("T")[0];
    }
    if (clean === "ayer" || clean === "yesterday" || clean === "ontem") {
      const yesterday = new Date(today);
      yesterday.setDate(yesterday.getDate() - 1);
      return yesterday.toISOString().split("T")[0];
    }

    const MONTHS = {
      // Español
      "enero": "01", "febrero": "02", "marzo": "03", "abril": "04",
      "mayo": "05", "junio": "06", "julio": "07", "agosto": "08",
      "septiembre": "09", "setiembre": "09", "octubre": "10",
      "noviembre": "11", "diciembre": "12",
      // Inglés
      "january": "01", "jan": "01", "february": "02", "feb": "02",
      "march": "03", "mar": "03", "april": "04", "apr": "04",
      "may": "05", "june": "06", "jun": "06", "july": "07", "jul": "07",
      "august": "08", "aug": "08", "september": "09", "sep": "09", "sept": "09",
      "october": "10", "oct": "10", "november": "11", "nov": "11",
      "december": "12", "dec": "12",
      // Portugués
      "janeiro": "01", "fevereiro": "02", "março": "03", "marco": "03",
      "abril": "04", "maio": "05", "junho": "06", "julho": "07",
      "setembro": "09", "outubro": "10", "novembro": "11", "dezembro": "12"
    };

    // Formato "15 de marzo de 2026", "15 de marzo" o inglés "15th march 2026" / "15 march"
    const match = clean.match(/^(\d{1,2})(?:st|nd|rd|th)?\s+(?:de\s+)?([a-zñáéíóúç]+)(?:\s+(?:del?\s+)?(\d{4}))?$/i);
    if (match) {
      const day = match[1].padStart(2, "0");
      const monthStr = match[2].toLowerCase();
      const year = match[3] || String(today.getFullYear());
      const month = MONTHS[monthStr];
      if (month) {
        return `${year}-${month}-${day}`;
      }
    }

    // Formato inglés "March 15, 2026" o "March 15th"
    const enMatch = clean.match(/^([a-zñáéíóúç]+)\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?$/i);
    if (enMatch) {
      const monthStr = enMatch[1].toLowerCase();
      const day = enMatch[2].padStart(2, "0");
      const year = enMatch[3] || String(today.getFullYear());
      const month = MONTHS[monthStr];
      if (month) {
        return `${year}-${month}-${day}`;
      }
    }

    // Formato "15/03/2026" o "15-03-2026"
    const slashMatch = clean.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
    if (slashMatch) {
      const day = slashMatch[1].padStart(2, "0");
      const month = slashMatch[2].padStart(2, "0");
      const year = slashMatch[3];
      return `${year}-${month}-${day}`;
    }

    return null;
  }

  /**
   * Selecciona una opción en un <select> nativo o simula la selección en un Combobox ARIA.
   */
  async #selectOption(targetId, optionQuery) {
    let el = null;
    if (targetId) {
      const cached = this.#nodeCache.get(String(targetId));
      el = cached?.DOMNode || cached;
    }
    if (!el && this.document?.activeElement) {
      el = this.document.activeElement;
    }
    if (!el) {
      el = this.document?.querySelector("select:not([disabled]), [role='combobox'], [role='listbox']");
    }
    if (!el) {
      return { success: false, error: "No se encontró elemento select o combobox" };
    }

    try {
      el.focus();
      this.#highlightElement(el);

      const cleanQuery = (optionQuery || "").toLowerCase().trim();

      // Caso 1: <select> nativo de HTML
      if (el.tagName?.toUpperCase() === "SELECT") {
        let bestIndex = -1;
        const options = Array.from(el.options || []);

        // 1. Coincidencia exacta de texto o valor
        bestIndex = options.findIndex(opt =>
          opt.text.toLowerCase().trim() === cleanQuery ||
          opt.value.toLowerCase().trim() === cleanQuery
        );

        // 2. Coincidencia parcial
        if (bestIndex === -1 && cleanQuery) {
          bestIndex = options.findIndex(opt =>
            opt.text.toLowerCase().includes(cleanQuery) ||
            opt.value.toLowerCase().includes(cleanQuery)
          );
        }

        // 3. Si el query es un número (ej. "opción 2" o "2")
        const numMatch = cleanQuery.match(/(?:opci[oó]n\s+)?(\d+)/i);
        if (bestIndex === -1 && numMatch) {
          const idx = parseInt(numMatch[1], 10) - 1;
          if (idx >= 0 && idx < options.length) {
            bestIndex = idx;
          }
        }

        if (bestIndex !== -1) {
          el.selectedIndex = bestIndex;
          el.dispatchEvent(new this.contentWindow.Event("input", { bubbles: true, cancelable: true }));
          el.dispatchEvent(new this.contentWindow.Event("change", { bubbles: true, cancelable: true }));
          return {
            success: true,
            targetId,
            selectedText: options[bestIndex].text,
            selectedValue: options[bestIndex].value,
            index: bestIndex,
          };
        }

        return { success: false, error: `Opción "${optionQuery}" no encontrada en <select>` };
      }

      // Caso 2: Custom ARIA Combobox / Listbox
      // Si está cerrado (aria-expanded="false"), lo abrimos
      if (el.getAttribute("aria-expanded") === "false") {
        el.click();
        await new Promise(r => this.contentWindow.requestAnimationFrame(r));
      }

      // Buscar opciones asociadas mediante aria-owns, aria-controls o dentro del sub-árbol
      const doc = this.document;
      let optionList = [];
      const controlsId = el.getAttribute("aria-controls") || el.getAttribute("aria-owns");
      if (controlsId) {
        const popup = doc.getElementById(controlsId);
        if (popup) {
          optionList = Array.from(popup.querySelectorAll("[role='option'], li, div[data-value]"));
        }
      }
      if (optionList.length === 0) {
        optionList = Array.from(el.querySelectorAll("[role='option'], li, div[data-value]"));
      }
      if (optionList.length === 0) {
        optionList = Array.from(doc.querySelectorAll("[role='listbox'] [role='option'], ul[role='listbox'] li"));
      }

      let bestOpt = null;
      for (const opt of optionList) {
        const text = (opt.textContent || opt.getAttribute("data-value") || opt.getAttribute("aria-label") || "").toLowerCase().trim();
        if (text === cleanQuery || text.includes(cleanQuery)) {
          bestOpt = opt;
          break;
        }
      }

      if (bestOpt) {
        bestOpt.click();
        this.#highlightElement(bestOpt);
        return {
          success: true,
          targetId,
          selectedText: bestOpt.textContent?.trim(),
          customAria: true,
        };
      }

      return { success: false, error: `Opción "${optionQuery}" no encontrada en combobox ARIA` };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  /**
   * Ajusta un slider o input numérico (<input type="range">, <input type="number">, ROLE_SLIDER, ROLE_SPINBUTTON).
   * @param {string|number} targetId
   * @param {string} direction - "set" | "increment" | "decrement"
   * @param {number} amount - valor numérico a asignar o variar
   */
  #adjustRange(targetId, direction = "set", amount = 0) {
    let el = null;
    if (targetId) {
      const cached = this.#nodeCache.get(String(targetId));
      el = cached?.DOMNode || cached;
    }
    if (!el && this.document?.activeElement) {
      el = this.document.activeElement;
    }
    if (!el) {
      el = this.document?.querySelector("input[type='range'], input[type='number'], [role='slider'], [role='spinbutton']");
    }
    if (!el) {
      return { success: false, error: "No se encontró control de rango o slider" };
    }

    try {
      el.focus();
      this.#highlightElement(el);

      const isRangeOrNumber = el.tagName?.toUpperCase() === "INPUT" &&
        (el.type === "range" || el.type === "number");

      if (isRangeOrNumber) {
        const min = el.min !== "" ? parseFloat(el.min) : 0;
        const max = el.max !== "" ? parseFloat(el.max) : 100;
        const step = el.step !== "" ? parseFloat(el.step) : 1;
        let current = el.value !== "" ? parseFloat(el.value) : min;

        let targetVal = current;
        if (direction === "set") {
          targetVal = amount;
        } else if (direction === "increment") {
          targetVal = current + (amount || step);
        } else if (direction === "decrement") {
          targetVal = current - (amount || step);
        }

        // Clamp
        targetVal = Math.max(min, Math.min(max, targetVal));

        const proto = Object.getPrototypeOf(el);
        const desc = Object.getOwnPropertyDescriptor(proto, "value");
        if (desc && desc.set) {
          desc.set.call(el, String(targetVal));
        } else {
          el.value = String(targetVal);
        }

        el.dispatchEvent(new this.contentWindow.Event("input", { bubbles: true, cancelable: true }));
        el.dispatchEvent(new this.contentWindow.Event("change", { bubbles: true, cancelable: true }));

        return {
          success: true,
          targetId,
          value: targetVal,
          min,
          max,
        };
      }

      // Si es un role="slider" ARIA sintético
      if (el.getAttribute("role") === "slider") {
        const valNow = parseFloat(el.getAttribute("aria-valuenow") || "0");
        const valMin = parseFloat(el.getAttribute("aria-valuemin") || "0");
        const valMax = parseFloat(el.getAttribute("aria-valuemax") || "100");

        let targetVal = valNow;
        if (direction === "set") {
          targetVal = amount;
        } else if (direction === "increment") {
          targetVal = valNow + (amount || 1);
        } else if (direction === "decrement") {
          targetVal = valNow - (amount || 1);
        }
        targetVal = Math.max(valMin, Math.min(valMax, targetVal));

        el.setAttribute("aria-valuenow", String(targetVal));
        el.dispatchEvent(new this.contentWindow.Event("input", { bubbles: true, cancelable: true }));
        el.dispatchEvent(new this.contentWindow.Event("change", { bubbles: true, cancelable: true }));

        return {
          success: true,
          targetId,
          value: targetVal,
          ariaSlider: true,
        };
      }

      return { success: false, error: "Elemento no es un slider ni input numérico compatible" };
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

    candidates.slice(0, 30).forEach((c, index) => {
      if (!c.bounds || c.bounds.width <= 0) return;
      const num = index + 1;
      const badge = doc.createElementNS("http://www.w3.org/1999/xhtml", "div");
      badge.setAttribute("data-badge-index", String(num));
      badge.style.cssText = `
        position: absolute;
        left: ${Math.max(0, c.bounds.x)}px;
        top: ${Math.max(0, c.bounds.y - 24)}px;
        background: linear-gradient(135deg, rgba(15, 23, 42, 0.88) 0%, rgba(30, 41, 59, 0.78) 100%);
        color: #38bdf8;
        border: 1px solid rgba(56, 189, 248, 0.45);
        box-shadow: 0 8px 20px rgba(0, 0, 0, 0.45), 0 0 1px 1px rgba(255, 255, 255, 0.12) inset, 0 0 12px rgba(56, 189, 248, 0.25);
        border-radius: 8px;
        padding: 3px 8px;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, system-ui, monospace;
        font-size: 11px;
        font-weight: 600;
        display: flex;
        align-items: center;
        gap: 6px;
        pointer-events: none;
        backdrop-filter: blur(16px) saturate(180%);
        -webkit-backdrop-filter: blur(16px) saturate(180%);
        transition: transform 0.15s ease, opacity 0.15s ease;
      `;

      const numSpan = doc.createElementNS("http://www.w3.org/1999/xhtml", "span");
      numSpan.style.cssText =
        "background: linear-gradient(135deg, #0284c7 0%, #2563eb 100%); color: #ffffff; padding: 1px 6px; border-radius: 5px; font-size: 10px; font-weight: 800; box-shadow: 0 2px 6px rgba(2, 132, 199, 0.4);";
      numSpan.textContent = String(num);
      badge.appendChild(numSpan);

      const labelSpan = doc.createElementNS("http://www.w3.org/1999/xhtml", "span");
      labelSpan.style.cssText =
        "color: #f8fafc; font-weight: 500; max-width: 140px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; letter-spacing: 0.2px;";
      labelSpan.textContent = (c.name || c.role || "item").slice(0, 22);
      badge.appendChild(labelSpan);

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
   * Variante Videntes: Destello visual (pulse ring) sobre el elemento activado
   * sincronizado mediante la Web Animations API para evitar temporizadores artificiales.
   */
  #highlightElement(domNode) {
    if (!domNode || !(domNode instanceof this.contentWindow.Element)) return;
    try {
      const anim = domNode.animate(
        [
          { outline: "3px solid #0969da" },
          { outline: "3px solid transparent" }
        ],
        { duration: 400, easing: "ease-out" }
      );
      anim.finished.catch(() => {});
    } catch (_) {}
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
    hud.textContent = "";

    const iconSpan = doc.createElement("span");
    iconSpan.style.fontSize = "22px";
    iconSpan.textContent = success ? "🎯" : "🎤";
    hud.appendChild(iconSpan);

    const textContainer = doc.createElement("div");

    const voiceTitle = doc.createElement("div");
    voiceTitle.style.fontWeight = "700";
    voiceTitle.style.color = "#fff";
    voiceTitle.textContent = `Voz: "${transcript}"`;
    textContainer.appendChild(voiceTitle);

    const actionDesc = doc.createElement("div");
    actionDesc.style.fontSize = "12px";
    actionDesc.style.color = success ? "#34d399" : "#fbbf24";
    actionDesc.textContent = success
      ? `Acción ejecutada (${decision?.latency_ms?.toFixed(1) || 0}ms)`
      : 'Sin coincidencia (prueba: "guardar", "inicio", "wikipedia")';
    textContainer.appendChild(actionDesc);

    hud.appendChild(textContainer);

    hud.style.opacity = "1";
    if (this._hudAnim) {
      try { this._hudAnim.cancel(); } catch (_) {}
    }
    try {
      this._hudAnim = hud.animate(
        [
          { opacity: 1, offset: 0 },
          { opacity: 1, offset: 0.85 },
          { opacity: 0, offset: 1 }
        ],
        { duration: 4000, fill: "forwards" }
      );
      this._hudAnim.finished.then(() => {
        hud.style.opacity = "0";
      }).catch(() => {});
    } catch (_) {
      hud.style.opacity = "1";
    }
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
