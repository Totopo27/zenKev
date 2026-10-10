const fs = require("fs");
const path = require("path");

const rootDir = path.resolve(__dirname, "..");
const soundDir = path.join(rootDir, "modules", "voice-nav", "sounds");
const outModule = path.join(rootDir, "modules", "voice-nav", "actors", "ZenVoiceEarconsData.sys.mjs");

let content = `// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

/**
 * @file ZenVoiceEarconsData.sys.mjs
 * Módulo de constantes base64 URI para reproducción inmediata de Earcons nativos.
 */

`;

for (const file of fs.readdirSync(soundDir)) {
  if (!file.endsWith(".wav")) continue;
  const b64 = fs.readFileSync(path.join(soundDir, file)).toString("base64");
  const name = file.replace(".wav", "").toUpperCase();
  content += `export const ${name}_URI = "data:audio/wav;base64,${b64}";\n`;
}

fs.writeFileSync(outModule, content, "utf-8");
console.log("Módulo ZenVoiceEarconsData.sys.mjs generado exitosamente en:", outModule);
