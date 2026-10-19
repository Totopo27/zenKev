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

// 3. Validar Fallback para texto plano heredado
const legacyPayload = parseIncomingVoicePayload("texto plano de prueba");
assert.equal(legacyPayload.action, "legacy_raw");
assert.equal(legacyPayload.raw_transcript, "texto plano de prueba");

console.log("✅ [TEST JS] Todos los tests de Command Intent pasaron exitosamente.");
