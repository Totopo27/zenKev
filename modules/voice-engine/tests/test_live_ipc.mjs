import { spawn } from "child_process";
import readline from "readline";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Test de integración End-to-End simulando la llamada de ZenVoiceEngineClient
 * contra el binario real zen-voice-engine.exe
 */
async function testLiveEngineIPC() {
  console.log("=== [TEST E2E] Conexión en vivo con zen-voice-engine.exe ===");

  const enginePath = process.env.ZEN_VOICE_ENGINE_BIN || path.resolve(__dirname, "../target/release/zen-voice-engine.exe");

  const engine = spawn(enginePath, [], {
    stdio: ["pipe", "pipe", "inherit"],
  });

  const rl = readline.createInterface({
    input: engine.stdout,
    crlfDelay: Infinity,
  });

  const candidatesMock = [
    {
      id: "101",
      role_id: 31,
      role: "button",
      name: "Iniciar sesión",
      description: "Acceso al sistema",
      bounds: { x: 10, y: 10, width: 80, height: 30 },
      is_visible: true,
      has_default_action: true,
    },
    {
      id: "102",
      role_id: 31,
      role: "button",
      name: "Configuración",
      description: "Ajustes de cuenta",
      bounds: { x: 100, y: 10, width: 90, height: 30 },
      is_visible: true,
      has_default_action: true,
    },
    {
      id: "103",
      role_id: 21,
      role: "link",
      name: "Ayuda y soporte",
      description: "Documentación",
      bounds: { x: 200, y: 10, width: 100, height: 30 },
      is_visible: true,
      has_default_action: true,
    },
  ];

  const request = {
    transcript: "abrir configuracion",
    candidates: candidatesMock,
    top_k: 5,
  };

  const startTime = process.hrtime.bigint();

  // Escuchar respuesta
  const responsePromise = new Promise((resolve) => {
    rl.once("line", (line) => {
      const endTime = process.hrtime.bigint();
      const roundtripMs = Number(endTime - startTime) / 1_000_000;
      resolve({ line, roundtripMs });
    });
  });

  // Enviar comando por stdin
  engine.stdin.write(JSON.stringify(request) + "\n");

  const { line, roundtripMs } = await responsePromise;
  console.log(`[RESPUESTA RECIBIDA en ${roundtripMs.toFixed(3)} ms]:\n`, line);

  const parsed = JSON.parse(line);
  console.log("\nDecisión del motor:");
  console.log("- Nodo seleccionado:", parsed.matched_id);
  console.log("- Acción determinada:", parsed.action);
  console.log("- Confianza:", parsed.confidence);
  console.log("- Latencia interna en Rust:", parsed.latency_ms.toFixed(3), "ms");

  if (parsed.matched_id === "102" && parsed.action === "click") {
    console.log("\n✅ [PASS] El motor identificó el botón correcto y la acción correspondiente.");
  } else {
    console.error("\n❌ [FAIL] La decisión no coincide con la esperada.");
  }

  engine.kill();
  process.exit(0);
}

testLiveEngineIPC().catch((err) => {
  console.error("Error en test E2E:", err);
  process.exit(1);
});
