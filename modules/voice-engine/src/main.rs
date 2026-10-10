// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

use mimalloc::MiMalloc;
use std::io::{self, BufRead, Write};
use std::sync::Arc;
use std::time::Instant;
use zen_voice_engine::audio_capture::AudioCapture;
use zen_voice_engine::ipc;
use zen_voice_engine::protocol::{ClassifyResult, EngineRequest};
use zen_voice_engine::stt::{SpeechToTextEngine, WhisperConfig};
use zen_voice_engine::vlm_engine::VisionLanguageEngine;
use zen_voice_engine::{lexical_ranker, log_debug, nli_engine};

// Activación del asignador mimalloc (Catálogo §14.1)
#[global_allocator]
static GLOBAL: MiMalloc = MiMalloc;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let classifier = nli_engine::IntentClassifier::new(0.40);
    let vlm_engine = VisionLanguageEngine::new(0.70);

    #[cfg(windows)]
    log_debug(&format!("Iniciando IPC reactivo por Named Pipe: {}", ipc::resolve_pipe_name()));
    #[cfg(unix)]
    log_debug(&format!("Iniciando IPC reactivo por Unix Socket: {:?}", ipc::resolve_socket_path()));

    if let Some(ref ipc_path) = ipc::resolve_ipc_file_path() {
        log_debug(&format!("Fallback IPC activo en archivo: {:?}", ipc_path));
    }

    // Inicialización del canal reactivo (Named Pipe en Windows / Sockets en Unix + fallback opcional)
    ipc::start_reactive_ipc(|transcript| {
        log_debug(&format!("Voz recibida por IPC reactivo: {}", transcript));
        ipc::emit_transcription_ready(transcript);
    });

    // Módulo de captura nativa de micrófono y STT (Fase 1: sustitución de Python)
    let audio_capture = Arc::new(AudioCapture::new());
    let stt_engine = Arc::new(SpeechToTextEngine::new(WhisperConfig::default()));

    let audio_capture_for_ctrl = Arc::clone(&audio_capture);
    let stt_engine_clone = Arc::clone(&stt_engine);

    // Arrancar la captura nativa si se solicita por flag de entorno o por defecto si está habilitado
    if std::env::var("ZEN_VOICE_AUTO_MIC").unwrap_or_default() == "1" {
        let stt = Arc::clone(&stt_engine_clone);
        let _ = audio_capture.start(move |audio_samples| {
            if let Ok(transcript) = stt.transcribe(&audio_samples) {
                if !transcript.trim().is_empty() {
                    log_debug(&format!("Audio capturado y transcripto nativamente: {}", transcript));
                    ipc::emit_transcription_ready(&transcript);
                }
            }
        });
    }

    let stdin = io::stdin();
    let stdout = io::stdout();

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

        // 1. Deserialización del request polimórfico (Classify o InspectVisual)
        let request: Result<EngineRequest, _> = serde_json::from_str(&line);
        match request {
            Ok(EngineRequest::Control(ctrl)) => {
                log_debug(&format!("STDIN ControlRequest: action='{}'", ctrl.action));
                match ctrl.action.as_str() {
                    "start_mic" => {
                        let stt = Arc::clone(&stt_engine_clone);
                        let res = audio_capture_for_ctrl.start(move |audio_samples| {
                            if let Ok(transcript) = stt.transcribe(&audio_samples) {
                                if !transcript.trim().is_empty() {
                                    log_debug(&format!("Audio capturado nativamente: {}", transcript));
                                    ipc::emit_transcription_ready(&transcript);
                                }
                            }
                        });
                        let status = if res.is_ok() { "started" } else { "error" };
                        let json_out = format!("{{\"type\":\"control_result\",\"action\":\"start_mic\",\"status\":\"{}\"}}\n", status);
                        let mut out = stdout.lock();
                        out.write_all(json_out.as_bytes())?;
                        out.flush()?;
                    }
                    "stop_mic" => {
                        audio_capture_for_ctrl.stop();
                        let json_out = "{\"type\":\"control_result\",\"action\":\"stop_mic\",\"status\":\"stopped\"}\n";
                        let mut out = stdout.lock();
                        out.write_all(json_out.as_bytes())?;
                        out.flush()?;
                    }
                    "toggle_mic" => {
                        let is_running = audio_capture_for_ctrl.is_running();
                        if is_running {
                            audio_capture_for_ctrl.stop();
                            let json_out = "{\"type\":\"control_result\",\"action\":\"toggle_mic\",\"status\":\"stopped\"}\n";
                            let mut out = stdout.lock();
                            out.write_all(json_out.as_bytes())?;
                            out.flush()?;
                        } else {
                            let stt = Arc::clone(&stt_engine_clone);
                            let res = audio_capture_for_ctrl.start(move |audio_samples| {
                                if let Ok(transcript) = stt.transcribe(&audio_samples) {
                                    if !transcript.trim().is_empty() {
                                        log_debug(&format!("Audio capturado nativamente: {}", transcript));
                                        ipc::emit_transcription_ready(&transcript);
                                    }
                                }
                            });
                            let status = if res.is_ok() { "started" } else { "error" };
                            let json_out = format!("{{\"type\":\"control_result\",\"action\":\"toggle_mic\",\"status\":\"{}\"}}\n", status);
                            let mut out = stdout.lock();
                            out.write_all(json_out.as_bytes())?;
                            out.flush()?;
                        }
                    }
                    _ => {
                        let json_out = "{\"type\":\"control_result\",\"status\":\"unknown_action\"}\n";
                        let mut out = stdout.lock();
                        out.write_all(json_out.as_bytes())?;
                        out.flush()?;
                    }
                }
            }
            Ok(EngineRequest::InspectVisual(req)) => {

                let result = vlm_engine.inspect_icon(&req);
                let elapsed_ms = start_time.elapsed().as_secs_f64() * 1000.0;
                log_debug(&format!(
                    "STDIN VisualInspectionResult: target_id={}, role={}, conf={:.2}, matches={}, latency={:.2}ms",
                    result.target_id, result.predicted_icon_role, result.confidence, result.matches_transcript, elapsed_ms
                ));

                let mut json_out = serde_json::to_string(&result)?;
                json_out.push('\n');
                let mut out = stdout.lock();
                out.write_all(json_out.as_bytes())?;
                out.flush()?;
            }
            Ok(EngineRequest::Classify(req)) => {
                let initial_count = req.candidates.len();
                log_debug(&format!(
                    "STDIN ClassifyRequest: transcript='{}', candidates={}",
                    req.transcript, initial_count
                ));

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
                log_debug(&format!(
                    "STDIN ClassifyResult: matched_id={:?}, action='{}', confidence={:.2}, latency={:.2}ms",
                    decision.matched_id, decision.action, decision.confidence, elapsed_ms
                ));

                let response = ClassifyResult {
                    matched_id: decision.matched_id,
                    action: decision.action,
                    confidence: decision.confidence,
                    fallback_to_vlm: decision.fallback_to_vlm,
                    latency_ms: elapsed_ms,
                    candidate_count_in: initial_count,
                    candidate_count_pruned: pruned_count,
                    tier: decision.tier,
                };

                let mut json_out = serde_json::to_string(&response)?;
                json_out.push('\n');
                let mut out = stdout.lock();
                out.write_all(json_out.as_bytes())?;
                out.flush()?;
            }
            Err(e) => {
                let response = ClassifyResult {
                    matched_id: None,
                    action: format!("error: {}", e),
                    confidence: 0.0,
                    fallback_to_vlm: false,
                    latency_ms: start_time.elapsed().as_secs_f64() * 1000.0,
                    candidate_count_in: 0,
                    candidate_count_pruned: 0,
                    tier: "none".to_string(),
                };

                let mut json_out = serde_json::to_string(&response)?;
                json_out.push('\n');
                let mut out = stdout.lock();
                out.write_all(json_out.as_bytes())?;
                out.flush()?;
            }
        }
    }

    // Al cerrarse el pipe stdin (cuando Zen Browser cierra el cliente), terminar limpiamente
    log_debug("Stdin cerrado por el proceso principal. Terminando zen-voice-engine limpiamente.");
    Ok(())
}
