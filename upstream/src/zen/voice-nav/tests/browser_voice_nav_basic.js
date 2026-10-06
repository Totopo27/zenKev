/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

/**
 * Validates the core JSWindowActor extraction and action dispatch
 * using the zero-dependency in-process mock engine.
 */
add_task(async function test_voice_nav_actor_basic() {
  await SpecialPowers.pushPrefEnv({
    set: [
      [VOICE_NAV_PREF_ENABLED, true],
      [VOICE_NAV_PREF_MOCK, true],
      [VOICE_NAV_PREF_MODE, "visual-overlay"],
    ],
  });

  const testUri = "data:text/html;charset=utf-8," + encodeURIComponent(`
    <!DOCTYPE html>
    <html>
      <head><meta charset="utf-8"><title>ZenVoiceNav Test Page</title></head>
      <body>
        <h1>Prueba de Accesibilidad</h1>
        <button id="btn-save" onclick="document.title='Guardado'">Guardar Cambios</button>
        <button id="btn-cancel" onclick="document.title='Cancelado'">Cancelar</button>
        <a id="link-github" href="https://github.com">Visitar GitHub</a>
      </body>
    </html>
  `);

  await BrowserTestUtils.withNewTab(testUri, async function (browser) {
    const cwg = browser.browsingContext.currentWindowGlobal;
    ok(cwg, "CurrentWindowGlobal exists for active browser tab");

    const actor = cwg.getActor("ZenVoiceNav");
    ok(actor, "ZenVoiceNav actor is successfully resolved via getActor");

    // 1. Test AOM candidates extraction
    const candidateResult = await actor.getCandidates(true);
    ok(candidateResult, "getCandidates returned a valid result object");
    ok(Array.isArray(candidateResult.candidates), "candidates is an array");
    ok(candidateResult.candidates.length >= 2, "Found actionable interactive elements in viewport");

    const saveCandidate = candidateResult.candidates.find(c => c.name === "Guardar Cambios");
    ok(saveCandidate, "Found 'Guardar Cambios' candidate button");

    // 2. Test voice command execution via in-process lexical matcher
    const cmdResult = await actor.processVoiceCommand("Guardar Cambios");
    ok(cmdResult.success, "Voice command processed successfully without external binary");
    is(cmdResult.matchedId, saveCandidate.id, "Target matched the expected AOM node ID");

    // Verify DOM mutation triggered by AOM doAction
    await BrowserTestUtils.waitForCondition(
      () => browser.contentDocument?.title === "Guardado",
      "Action triggered native click handler and updated page title"
    );
  });
});
