import { spawn } from "child_process";
import readline from "readline";

async function benchmarkPipelinedThroughput() {
  console.log("=== [BENCHMARK] Throughput en pipeline continuo sobre zen-voice-engine ===");

  const path = require("path");
  const enginePath = process.env.ZEN_VOICE_ENGINE_BIN || path.resolve(__dirname, "../target/release/zen-voice-engine.exe");
  const engine = spawn(enginePath, [], { stdio: ["pipe", "pipe", "inherit"] });

  const rl = readline.createInterface({ input: engine.stdout, crlfDelay: Infinity });

  const iterations = 50;
  const candidates = [
    { id: "1", role_id: 31, role: "button", name: "Inicio", description: "", bounds: { x:0,y:0,width:10,height:10 }, is_visible: true, has_default_action: true },
    { id: "2", role_id: 31, role: "button", name: "Configuración", description: "", bounds: { x:0,y:0,width:10,height:10 }, is_visible: true, has_default_action: true },
    { id: "3", role_id: 21, role: "link", name: "Descargas", description: "", bounds: { x:0,y:0,width:10,height:10 }, is_visible: true, has_default_action: true }
  ];

  let received = 0;
  const startTime = process.hrtime.bigint();

  const promise = new Promise((resolve) => {
    rl.on("line", () => {
      received++;
      if (received === iterations) {
        resolve();
      }
    });
  });

  for (let i = 0; i < iterations; i++) {
    const payload = JSON.stringify({
      transcript: i % 2 === 0 ? "abrir configuracion" : "descargas",
      candidates,
      top_k: 5
    }) + "\n";
    engine.stdin.write(payload);
  }

  await promise;
  const totalMs = Number(process.hrtime.bigint() - startTime) / 1_000_000;
  const avgPerMsg = totalMs / iterations;

  console.log(`- Total mensajes procesados: ${iterations}`);
  console.log(`- Tiempo total: ${totalMs.toFixed(2)} ms`);
  console.log(`- Promedio ida y vuelta por mensaje (IPC + Inferencia): ${avgPerMsg.toFixed(3)} ms`);
  console.log(`- Capacidad proyectada: ${(1000 / avgPerMsg).toFixed(0)} mensajes/segundo`);

  engine.kill();
}

benchmarkPipelinedThroughput().catch(console.error);
