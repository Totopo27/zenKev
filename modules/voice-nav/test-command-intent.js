/**
 * @file test-command-intent.js
 * Test unitario para validar el contrato de Command Intent (ADR-0001).
 * Ejecutable vía Node.js sin depender del runtime completo de Gecko.
 */

import assert from "node:assert/strict";

function parseIncomingVoicePayload(raw) {
  if (!raw) return null;
  if (typeof raw === "object" && raw !== null && raw.type === "command_intent") {
    return raw;
  }
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && parsed.type === "command_intent") {
          return parsed;
        }
      } catch (_) {}
    }
  }
  return {
    type: "command_intent",
    action: "legacy_raw",
    raw_transcript: raw,
  };
}

// 1. Validar Command Intent JSON
const jsonPayload = JSON.stringify({
  type: "command_intent",
  action: "scroll",
  params: { direction: "down", amount: 300 },
  raw_transcript: "baja un poco",
  confidence: 0.95,
});

const parsedIntent = parseIncomingVoicePayload(jsonPayload);
assert.equal(parsedIntent.type, "command_intent");
assert.equal(parsedIntent.action, "scroll");
assert.equal(parsedIntent.params.direction, "down");
assert.equal(parsedIntent.params.amount, 300);

// 2. Validar Badge Selection
const badgePayload = JSON.stringify({
  type: "command_intent",
  action: "click_badge",
  params: { badge_index: 4 },
  raw_transcript: "clic 4",
  confidence: 0.98,
});

const parsedBadge = parseIncomingVoicePayload(badgePayload);
assert.equal(parsedBadge.action, "click_badge");
assert.equal(parsedBadge.params.badge_index, 4);

// 3. Validar History & Zoom Actions
const historyPayload = JSON.stringify({
  type: "command_intent",
  action: "history_action",
  params: { operation: "back" },
  raw_transcript: "ir atrás",
  confidence: 0.94,
});
const parsedHistory = parseIncomingVoicePayload(historyPayload);
assert.equal(parsedHistory.action, "history_action");
assert.equal(parsedHistory.params.operation, "back");

const zoomPayload = JSON.stringify({
  type: "command_intent",
  action: "zoom_action",
  params: { operation: "in" },
  raw_transcript: "aumentar zoom",
  confidence: 0.93,
});
const parsedZoom = parseIncomingVoicePayload(zoomPayload);
assert.equal(parsedZoom.action, "zoom_action");
assert.equal(parsedZoom.params.operation, "in");

const windowPayload = JSON.stringify({
  type: "command_intent",
  action: "window_action",
  params: { operation: "new_private" },
  raw_transcript: "ventana privada",
  confidence: 0.94,
});
const parsedWindow = parseIncomingVoicePayload(windowPayload);
assert.equal(parsedWindow.action, "window_action");
assert.equal(parsedWindow.params.operation, "new_private");

// 4. Validar Bookmark & Download Actions
const bmPayload = JSON.stringify({
  type: "command_intent",
  action: "bookmark_action",
  params: { operation: "save" },
  raw_transcript: "guardar marcador",
  confidence: 0.96,
});
const parsedBm = parseIncomingVoicePayload(bmPayload);
assert.equal(parsedBm.action, "bookmark_action");
assert.equal(parsedBm.params.operation, "save");

const dlPayload = JSON.stringify({
  type: "command_intent",
  action: "download_action",
  params: { operation: "open_panel" },
  raw_transcript: "abrir descargas",
  confidence: 0.95,
});
const parsedDl = parseIncomingVoicePayload(dlPayload);
assert.equal(parsedDl.action, "download_action");
assert.equal(parsedDl.params.operation, "open_panel");

// 5. Validar Fullscreen Action
const fsPayload = JSON.stringify({
  type: "command_intent",
  action: "fullscreen_action",
  params: { operation: "toggle" },
  raw_transcript: "pantalla completa",
  confidence: 0.96,
});
const parsedFs = parseIncomingVoicePayload(fsPayload);
assert.equal(parsedFs.action, "fullscreen_action");
assert.equal(parsedFs.params.operation, "toggle");

// 6. Validar Fallback para texto plano heredado
const legacyPayload = parseIncomingVoicePayload("texto plano de prueba");
assert.equal(legacyPayload.action, "legacy_raw");
assert.equal(legacyPayload.raw_transcript, "texto plano de prueba");

console.log("✅ [TEST JS] Todos los tests de Command Intent pasaron exitosamente.");
