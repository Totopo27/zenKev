/**
 * @file test-hud.js
 * Test unitario para validar la interfaz pública del módulo ZenVoiceHUD.
 */

import assert from "node:assert/strict";

// Mock mínimo de Services para Node.js
globalThis.Services = {
  prefs: {
    getBoolPref: () => false,
  },
  wm: {
    getMostRecentWindow: () => null,
    getEnumerator: () => ({
      hasMoreElements: () => false,
      getNext: () => null,
    }),
  },
  zenVoiceNavButtonState: "listening",
};

// Importar el módulo ZenVoiceHUD
import {
  ZenVoiceHUD,
  getVoiceNavButtonIcon,
  updateVoiceNavButtonState,
} from "./actors/ZenVoiceHUD.sys.mjs";

// 1. Probar que los métodos públicos existen
assert.equal(typeof ZenVoiceHUD.show, "function");
assert.equal(typeof ZenVoiceHUD.getButtonIcon, "function");
assert.equal(typeof ZenVoiceHUD.updateButtonState, "function");

// 2. Probar la generación de iconos SVG vectoriales según el estado
const listeningIcon = getVoiceNavButtonIcon("listening");
assert.match(listeningIcon, /^data:image\/svg\+xml/);
assert.match(listeningIcon, /(?:#10b981|%2310b981)/); // Verde

const mutedIcon = getVoiceNavButtonIcon("muted");
assert.match(mutedIcon, /^data:image\/svg\+xml/);
assert.match(mutedIcon, /(?:#ef4444|%23ef4444)/); // Rojo / tachado

const processingIcon = getVoiceNavButtonIcon("processing");
assert.match(processingIcon, /^data:image\/svg\+xml/);
assert.match(processingIcon, /(?:#c084fc|%23c084fc)/); // Púrpura


// 3. Probar la actualización de estado
updateVoiceNavButtonState("muted");
assert.equal(Services.zenVoiceNavButtonState, "muted");

updateVoiceNavButtonState("listening");
assert.equal(Services.zenVoiceNavButtonState, "listening");

console.log("✅ [TEST JS] Todos los tests de ZenVoiceHUD pasaron exitosamente.");
