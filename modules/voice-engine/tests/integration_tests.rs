use std::time::Instant;
use zen_voice_engine::protocol::{BoundingBox, CandidateNode};
use zen_voice_engine::{lexical_ranker, nli_engine};

fn create_mock_candidate(id: usize, name: &str, role: &str) -> CandidateNode {
    CandidateNode {
        id: id.to_string(),
        role_id: 31,
        role: role.to_string(),
        name: name.to_string(),
        description: format!("Descripción de accesibilidad para {}", name),
        bounds: BoundingBox {
            x: (id % 10 * 100) as f64,
            y: (id / 10 * 40) as f64,
            width: 90.0,
            height: 30.0,
        },
        is_visible: true,
        has_default_action: true,
    }
}

#[test]
fn test_lexical_pruning_and_nli_decision() {
    let classifier = nli_engine::IntentClassifier::new(0.40);

    let candidates = vec![
        create_mock_candidate(1, "Inicio de sesión", "button"),
        create_mock_candidate(2, "Configuración avanzada", "link"),
        create_mock_candidate(3, "Cerrar ventana", "button"),
        create_mock_candidate(4, "Buscar en la página", "entry"),
        create_mock_candidate(5, "", "button"), // Botón mudo
    ];

    // Caso 1: Coincidencia con acentos y variaciones
    let pruned = lexical_ranker::rank_and_prune("abrir configuracion", &candidates, 3);
    assert_eq!(pruned.len(), 3);
    assert_eq!(pruned[0].id, "2"); // Debe elegir "Configuración avanzada"

    let decision = classifier.evaluate("abrir configuracion", &pruned);
    assert_eq!(decision.matched_id, Some("2".to_string()));
    assert_eq!(decision.action, "click");
    assert_eq!(decision.tier, "tier1_lexical");
    assert!(!decision.fallback_to_vlm);

    // Caso 2: Campo de entrada (Entry) debe mapear a 'focus'
    let pruned_entry = lexical_ranker::rank_and_prune("buscar", &candidates, 3);
    let decision_entry = classifier.evaluate("buscar", &pruned_entry);
    assert_eq!(decision_entry.matched_id, Some("4".to_string()));
    assert_eq!(decision_entry.action, "focus");
    assert_eq!(decision_entry.tier, "tier1_lexical");

    // Caso 3: Botón mudo debe disparar fallback a Sistema 2 (VLM)
    let silent_candidates = vec![create_mock_candidate(5, "", "button")];
    let pruned_silent = lexical_ranker::rank_and_prune("icono", &silent_candidates, 1);
    let decision_silent = classifier.evaluate("icono", &pruned_silent);
    assert!(decision_silent.fallback_to_vlm);
    assert_eq!(decision_silent.action, "inspect_visual");
}

#[test]
fn test_tier2_semantic_fallback_synonyms() {
    let classifier = nli_engine::IntentClassifier::new(0.40);

    let candidates = vec![
        create_mock_candidate(10, "Finalizar compra y pagar", "button"),
        create_mock_candidate(20, "Opciones de cuenta y perfil", "link"),
        create_mock_candidate(30, "Descargar instalador", "button"),
    ];

    // Frase con sinónimo: "quiero pagar mi pedido" -> debe activar Tier 2 Semántico y asociarse a "Finalizar compra y pagar"
    let pruned = lexical_ranker::rank_and_prune("quiero pagar mi pedido", &candidates, 3);
    let decision = classifier.evaluate("quiero pagar mi pedido", &pruned);

    assert_eq!(decision.matched_id, Some("10".to_string()));
    assert_eq!(decision.action, "click");
    assert_eq!(decision.tier, "tier2_semantic");
    assert!(!decision.fallback_to_vlm);

    // Sinónimo conceptual: "ajustes" -> debe resolver a "Opciones de cuenta y perfil" por concepto semántico
    let pruned_settings = lexical_ranker::rank_and_prune("ajustes", &candidates, 3);
    let decision_settings = classifier.evaluate("ajustes", &pruned_settings);
    assert_eq!(decision_settings.matched_id, Some("20".to_string()));
    assert_eq!(decision_settings.tier, "tier2_semantic");
}

#[test]
fn test_latency_stress_benchmark_100_candidates() {
    let classifier = nli_engine::IntentClassifier::new(0.40);

    // Simular un DOM complejo con 100 elementos interactivos
    let mut candidates = Vec::with_capacity(100);
    for i in 0..100 {
        let name = match i {
            42 => "Configuración de privacidad",
            88 => "Descargar archivo",
            _ => "Enlace genérico de navegación",
        };
        candidates.push(create_mock_candidate(i, name, "link"));
    }

    let start = Instant::now();

    // 1. Poda léxica
    let pruned = lexical_ranker::rank_and_prune("configuración", &candidates, 10);

    // 2. Decisión NLI
    let decision = classifier.evaluate("configuración", &pruned);

    let total_elapsed = start.elapsed();
    let elapsed_ms = total_elapsed.as_secs_f64() * 1000.0;

    println!("\n[BENCHMARK] Tiempo para 100 candidatos: {:.3} ms", elapsed_ms);

    assert_eq!(decision.matched_id, Some("42".to_string()));
    // Verificación de presupuesto con tolerancia según perfil de compilación
    let max_budget_ms = if cfg!(debug_assertions) { 15.0 } else { 5.0 };
    assert!(
        elapsed_ms < max_budget_ms,
        "La latencia superó el presupuesto permitido de {} ms: {:.3} ms",
        max_budget_ms,
        elapsed_ms
    );
}

#[cfg(windows)]
#[tokio::test]
async fn test_reactive_named_pipe_ipc_submillisecond() {
    use tokio::io::AsyncWriteExt;
    use tokio::net::windows::named_pipe::ClientOptions;
    use tokio::sync::mpsc;
    use zen_voice_engine::ipc;

    let pipe_name = format!(r"\\.\pipe\zen_integ_test_{}", std::process::id());
    let (tx, mut rx) = mpsc::channel(16);

    let pipe_server = pipe_name.clone();
    tokio::spawn(async move {
        let _ = ipc::run_named_pipe_server(pipe_server, move |t| {
            let _ = tx.try_send(t.to_string());
        }).await;
    });

    tokio::time::sleep(std::time::Duration::from_millis(50)).await;

    // Conexión cliente al Named Pipe
    let mut client = ClientOptions::new().open(&pipe_name).expect("Conexión al pipe");

    let phrases = vec!["inicio", "guardar cambios", "configuracion", "cancelar"];
    for phrase in &phrases {
        let t0 = Instant::now();
        client.write_all(format!("{}\n", phrase).as_bytes()).await.expect("Escribir comando");
        client.flush().await.expect("Flush comando");

        let rec = tokio::time::timeout(std::time::Duration::from_millis(100), rx.recv())
            .await
            .expect("Timeout esperando evento reactivo")
            .expect("Canal cerrado prematuramente");

        let dt = t0.elapsed();
        println!("[INTEG NAMED PIPE] '{}' recibido reactivamente en: {:?}", phrase, dt);
        assert_eq!(&rec, phrase);
        assert!(dt.as_millis() < 15, "Latencia reactiva debe ser < 15ms sin sleep continuo");
    }
}

#[test]
fn test_vlm_visual_inspection_pipeline() {
    use zen_voice_engine::vlm_engine::{VisionLanguageEngine, VisualInspectionRequest};

    let vlm = VisionLanguageEngine::new(0.70);

    // 1. Petición válida de inspección visual de botón mudo
    let req = VisualInspectionRequest {
        request_type: Some("inspect_visual".to_string()),
        target_id: "mute-btn-1".to_string(),
        transcript: "abrir configuracion".to_string(),
        image_data_base64: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==".to_string(),
        width: 128,
        height: 128,
    };

    let start = Instant::now();
    let res = vlm.inspect_icon(&req);
    let elapsed = start.elapsed();
    let elapsed_ms = elapsed.as_secs_f64() * 1000.0;

    println!("\n[VLM TEST] Tiempo de inspección visual CPU: {:.3} ms", elapsed_ms);

    assert_eq!(res.target_id, "mute-btn-1");
    assert_eq!(res.predicted_icon_role, "boton_configuracion");
    assert!(res.confidence >= 0.70);
    assert!(res.matches_transcript);
    assert_eq!(res.suggested_action, "click");
    assert!(elapsed_ms < 10.0, "La inferencia VLM debe ejecutarse en < 10ms en CPU: {:.3}ms", elapsed_ms);

    // 2. Invariante de seguridad: Dimensiones inválidas (> 256 px) deben ser rechazadas
    let oversized_req = VisualInspectionRequest {
        request_type: Some("inspect_visual".to_string()),
        target_id: "oversized-btn".to_string(),
        transcript: "configuracion".to_string(),
        image_data_base64: "dummy".to_string(),
        width: 512,
        height: 512,
    };
    let oversized_res = vlm.inspect_icon(&oversized_req);
    assert_eq!(oversized_res.confidence, 0.0);
    assert!(!oversized_res.matches_transcript);
    assert_eq!(oversized_res.predicted_icon_role, "invalid_dimensions");

    // 3. Descarte por discrepancia visual
    let mismatch_req = VisualInspectionRequest {
        request_type: Some("inspect_visual".to_string()),
        target_id: "mismatch-btn".to_string(),
        transcript: "descartar elemento no_match".to_string(),
        image_data_base64: "dummy".to_string(),
        width: 128,
        height: 128,
    };
    let mismatch_res = vlm.inspect_icon(&mismatch_req);
    assert!(!mismatch_res.matches_transcript);
    assert!(mismatch_res.confidence < 0.70);
}

#[test]
fn test_engine_request_polymorphic_deserialization() {
    use zen_voice_engine::protocol::EngineRequest;

    // Caso A: ClassifyRequest tradicional sin campo "type"
    let json_classify = r#"{
        "transcript": "abrir configuracion",
        "candidates": [],
        "top_k": 5
    }"#;
    let req: Result<EngineRequest, _> = serde_json::from_str(json_classify);
    assert!(req.is_ok());
    match req.unwrap() {
        EngineRequest::Classify(c) => {
            assert_eq!(c.transcript, "abrir configuracion");
            assert_eq!(c.top_k, 5);
        }
        _ => panic!("Esperaba EngineRequest::Classify"),
    }

    // Caso B: ClassifyRequest con campo "type"
    let json_classify_typed = r#"{
        "type": "classify",
        "transcript": "cerrar ventana",
        "candidates": [],
        "top_k": 3
    }"#;
    let req_typed: Result<EngineRequest, _> = serde_json::from_str(json_classify_typed);
    assert!(req_typed.is_ok());
    match req_typed.unwrap() {
        EngineRequest::Classify(c) => {
            assert_eq!(c.transcript, "cerrar ventana");
        }
        _ => panic!("Esperaba EngineRequest::Classify"),
    }

    // Caso C: VisualInspectionRequest con campo "type": "inspect_visual"
    let json_vlm = r#"{
        "type": "inspect_visual",
        "target_id": "42",
        "transcript": "buscar",
        "image_data_base64": "data:image/png;base64,abc",
        "width": 128,
        "height": 128
    }"#;
    let req_vlm: Result<EngineRequest, _> = serde_json::from_str(json_vlm);
    assert!(req_vlm.is_ok());
    match req_vlm.unwrap() {
        EngineRequest::InspectVisual(v) => {
            assert_eq!(v.target_id, "42");
            assert_eq!(v.transcript, "buscar");
            assert_eq!(v.width, 128);
            assert_eq!(v.height, 128);
        }
        _ => panic!("Esperaba EngineRequest::InspectVisual"),
    }
}
