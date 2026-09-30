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
    assert!(!decision.fallback_to_vlm);

    // Caso 2: Campo de entrada (Entry) debe mapear a 'focus'
    let pruned_entry = lexical_ranker::rank_and_prune("buscar", &candidates, 3);
    let decision_entry = classifier.evaluate("buscar", &pruned_entry);
    assert_eq!(decision_entry.matched_id, Some("4".to_string()));
    assert_eq!(decision_entry.action, "focus");

    // Caso 3: Botón mudo debe disparar fallback a Sistema 2 (VLM)
    let silent_candidates = vec![create_mock_candidate(5, "", "button")];
    let pruned_silent = lexical_ranker::rank_and_prune("icono", &silent_candidates, 1);
    let decision_silent = classifier.evaluate("icono", &pruned_silent);
    assert!(decision_silent.fallback_to_vlm);
    assert_eq!(decision_silent.action, "inspect_visual");
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
    // Verificación estricta del presupuesto: debe resolver en menos de 5 ms en CPU
    assert!(
        elapsed_ms < 5.0,
        "La latencia superó el presupuesto permitido de 5 ms: {:.3} ms",
        elapsed_ms
    );
}
