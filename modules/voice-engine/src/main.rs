use mimalloc::MiMalloc;
use std::io::{self, BufRead, Write};
use std::path::PathBuf;
use std::time::Instant;
use zen_voice_engine::protocol::{ClassifyRequest, ClassifyResult};
use zen_voice_engine::{lexical_ranker, nli_engine};

// Activación del asignador mimalloc (Catálogo §14.1)
#[global_allocator]
static GLOBAL: MiMalloc = MiMalloc;

/// Log de depuración condicional activado por la variable de entorno ZEN_VOICE_ENGINE_LOG
fn log_debug(msg: &str) {
    if let Ok(log_path) = std::env::var("ZEN_VOICE_ENGINE_LOG") {
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(log_path) {
            let _ = writeln!(f, "{}", msg);
        }
    }
}

/// Resuelve dinámicamente la ruta del archivo IPC sin dependencias de rutas fijas:
/// 1. Variable de entorno ZEN_VOICE_IPC_PATH.
/// 2. Argumento de línea de comando `--ipc <path>` o `--ipc-path <path>`.
/// 3. Archivo voice_command.ipc en el directorio actual.
/// 4. Fallback al directorio temporal del sistema operativo (std::env::temp_dir()).
fn resolve_ipc_path() -> PathBuf {
    if let Ok(path) = std::env::var("ZEN_VOICE_IPC_PATH") {
        return PathBuf::from(path);
    }

    let args: Vec<String> = std::env::args().collect();
    for i in 0..args.len() {
        if (args[i] == "--ipc" || args[i] == "--ipc-path") && i + 1 < args.len() {
            return PathBuf::from(&args[i + 1]);
        }
    }

    let local_ipc = PathBuf::from("voice_command.ipc");
    if local_ipc.exists() {
        return local_ipc;
    }

    std::env::temp_dir().join("zen_voice_command.ipc")
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let classifier = nli_engine::IntentClassifier::new(0.40);

    let ipc_file_path = resolve_ipc_path();
    log_debug(&format!("Starting zen-voice-engine main with IPC path: {:?}", ipc_file_path));

    // Inicializar archivo IPC si no existe
    if !ipc_file_path.exists() {
        let _ = std::fs::write(&ipc_file_path, "");
    }

    // Canal en segundo plano para recibir voz transcrita en vivo (IPC ultrarrápido sin dependencias de red)
    let ipc_path_clone = ipc_file_path.clone();
    std::thread::spawn(move || {
        use std::io::{BufRead, BufReader, Seek, SeekFrom};
        let mut last_pos: u64 = 0;
        log_debug(&format!("IPC listener activo en {:?}", ipc_path_clone));

        loop {
            if let Ok(metadata) = std::fs::metadata(&ipc_path_clone) {
                let len = metadata.len();
                if len > last_pos {
                    if let Ok(mut file) = std::fs::File::open(&ipc_path_clone) {
                        if file.seek(SeekFrom::Start(last_pos)).is_ok() {
                            let reader = BufReader::new(file);
                            for line in reader.lines() {
                                if let Ok(l) = line {
                                    let trimmed = l.trim();
                                    if !trimmed.is_empty() {
                                        log_debug(&format!("Voz recibida por IPC: {}", trimmed));
                                        let json = serde_json::json!({
                                            "type": "transcription_ready",
                                            "transcript": trimmed
                                        });
                                        let mut out = io::stdout().lock();
                                        let _ = writeln!(out, "{}", json);
                                        let _ = out.flush();
                                    }
                                }
                            }
                        }
                    }
                    last_pos = len;
                } else if len < last_pos {
                    last_pos = 0;
                }
            }
            std::thread::sleep(std::time::Duration::from_millis(15));
        }
    });

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
                log_debug(&format!("STDIN ClassifyRequest: transcript='{}', candidates={}", req.transcript, initial_count));

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
                log_debug(&format!("STDIN ClassifyResult: matched_id={:?}, action='{}', confidence={:.2}, latency={:.2}ms", decision.matched_id, decision.action, decision.confidence, elapsed_ms));

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

    // Al cerrarse el pipe stdin (cuando Zen Browser cierra el cliente), terminar limpiamente
    log_debug("Stdin cerrado por el proceso principal. Terminando zen-voice-engine limpiamente.");
    Ok(())
}
