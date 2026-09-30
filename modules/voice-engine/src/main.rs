use mimalloc::MiMalloc;
use std::io::{self, BufRead, Write};
use std::time::Instant;
use zen_voice_engine::protocol::{ClassifyRequest, ClassifyResult};
use zen_voice_engine::{lexical_ranker, nli_engine};

// Activación del asignador mimalloc (Catálogo §14.1)
#[global_allocator]
static GLOBAL: MiMalloc = MiMalloc;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let classifier = nli_engine::IntentClassifier::new(0.40);

    let stdin = io::stdin();
    let mut stdout = io::stdout();

    // Procesamiento línea a línea (NDJSON / Stdio IPC)
    for line in stdin.lock().lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => break,
        };

        if line.trim().is_empty() {
            continue;
        }

        let start_time = Instant::now();

        // 1. Deserialización del request
        let request: Result<ClassifyRequest, _> = serde_json::from_str(&line);
        let response = match request {
            Ok(req) => {
                let initial_count = req.candidates.len();

                // 2. Pre-ranking y poda léxica (<1ms)
                let pruned = lexical_ranker::rank_and_prune(
                    &req.transcript,
                    &req.candidates,
                    req.top_k,
                );
                let pruned_count = pruned.len();

                // 3. Decisión de acción (Sistema 1 NLI)
                let decision = classifier.evaluate(&req.transcript, &pruned);

                let elapsed_ms = start_time.elapsed().as_secs_f64() * 1000.0;

                ClassifyResult {
                    matched_id: decision.matched_id,
                    action: decision.action,
                    confidence: decision.confidence,
                    fallback_to_vlm: decision.fallback_to_vlm,
                    latency_ms: elapsed_ms,
                    candidate_count_in: initial_count,
                    candidate_count_pruned: pruned_count,
                }
            }
            Err(e) => ClassifyResult {
                matched_id: None,
                action: format!("error: {}", e),
                confidence: 0.0,
                fallback_to_vlm: false,
                latency_ms: start_time.elapsed().as_secs_f64() * 1000.0,
                candidate_count_in: 0,
                candidate_count_pruned: 0,
            },
        };

        // 4. Emisión atómica de la respuesta JSON por stdout
        let mut json_out = serde_json::to_string(&response)?;
        json_out.push('\n');
        stdout.write_all(json_out.as_bytes())?;
        stdout.flush()?;
    }

    Ok(())
}
