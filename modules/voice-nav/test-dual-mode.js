// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

/**
 * @file test-dual-mode.js
 * Script de validación de las variantes:
 * 1. Modo Screen Reader (No Videntes): accNode.announce + takeFocus.
 * 2. Modo Visual Overlay (Videntes): showVisualOverlay + highlightElement.
 */

export async function runDualModeCheck(actor) {
  console.log("=== [TEST] Probando Variantes de Accesibilidad y Visual ===");

  // 1. Obtener candidatos interactivos
  const candidatesResult = await actor.getCandidates(true);
  console.log(`Candidatos recolectados: ${candidatesResult.candidates.length}`);

  if (candidatesResult.candidates.length === 0) {
    return { success: false, reason: "No hay candidatos" };
  }

  const target = candidatesResult.candidates[0];

  // 2. Probar Variante Videntes (Visual Overlay)
  console.log("[TEST] Activando Overlay Visual para Videntes...");
  const overlayRes = await actor.showVisualOverlay(candidatesResult.candidates);
  console.log(`Badges renderizados en viewport: ${overlayRes.count}`);

  // 3. Probar Ejecución en Modo Visual (Highlight)
  console.log(`[TEST] Ejecutando acción en nodo ${target.id} en modo visual-overlay...`);
  const visualAction = await actor.executeAction(target.id, 0, "visual-overlay");
  console.log("Acción visual ejecutada:", visualAction);

  // 4. Ocultar Overlay
  await actor.hideVisualOverlay();

  // 5. Probar Variante No Videntes (Screen Reader Announce)
  console.log(`[TEST] Ejecutando acción en nodo ${target.id} en modo screen-reader...`);
  const srAction = await actor.executeAction(target.id, 0, "screen-reader");
  console.log("Acción para lector de pantalla ejecutada:", srAction);

  return {
    success: true,
    visualAction,
    srAction,
  };
}
