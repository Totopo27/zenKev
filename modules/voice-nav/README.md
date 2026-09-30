# Fase 1: Extractor AOM Mínimo (Zen Voice Navigator)

Este módulo implementa el extractor y actuador de accesibilidad para **Zen Browser (Gecko)** utilizando la API oficial `JSWindowActor`.

---

## 1. Componentes Implementados

* **`ZenVoiceNavChild.sys.mjs` (Content Process):**
  * Conexión con `nsIAccessibilityService`.
  * Recorrido recursivo del árbol AOM (`rootAcc`).
  * **Filtro de roles accionables:** `ROLE_PUSHBUTTON`, `ROLE_LINK`, `ROLE_ENTRY`, `ROLE_CHECKBUTTON`, `ROLE_COMBOBOX`, `ROLE_SWITCH`, etc.
  * **Poda por Viewport en origen:** Obtiene límites con `getBoundsInCSSPixels` e intersecta con las dimensiones de la ventana (`innerWidth`, `innerHeight`), descartando nodos invisibles o fuera de pantalla.
  * **Caché local de referencias:** Mapea `uniqueID -> nsIAccessible`.
  * **Actuador:** Ejecuta `doAction(0)` o `takeFocus()` según la instrucción recibida.

* **`ZenVoiceNavParent.sys.mjs` (Parent / Chrome Process):**
  * Expone métodos de consulta (`getCandidates`, `executeAction`, `focusTarget`) sobre la pestaña seleccionada.
  * Sirve de puente con el demonio de voz en Rust mediante IPC.

* **`registration.json`:**
  * Declaración para `ZenActorsManager.sys.mjs` o `ChromeUtils.registerWindowActor`.

---

## 2. Forma de los Datos Producidos (Contrato de Salida)

Cada elemento extraído responde a la siguiente estructura:

```json
{
  "id": "1042",
  "roleId": 31,
  "role": "pushbutton",
  "name": "Guardar cambios",
  "description": "Guarda los ajustes del perfil de usuario",
  "bounds": {
    "x": 120,
    "y": 450,
    "width": 140,
    "height": 38
  },
  "isVisible": true,
  "hasDefaultAction": true
}
```

---

## 3. Integración en Zen Browser

Para activarlo en el árbol de Zen:
1. Copiar los archivos `.sys.mjs` al directorio de actores (`src/zen/voice-nav/actors/` o `src/zen/common/actors/`).
2. Registrar la entrada de `registration.json` dentro de `JSWINDOWACTORS` en `src/zen/common/sys/ZenActorsManager.sys.mjs`.
3. Invocar desde la UI o consola interna de Zen:
   ```javascript
   const actor = gBrowser.selectedBrowser.browsingContext.currentWindowGlobal.getActor("ZenVoiceNav");
   const data = await actor.getCandidates(true);
   console.log("Candidatos AOM podados:", data.candidates);
   ```
