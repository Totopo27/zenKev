use std::time::Instant;
use zen_voice_engine::lexical_ranker;
use zen_voice_engine::protocol::{BoundingBox, CandidateNode, ClassifyRequest};

fn create_adversarial_node(id: usize, name: &str, role: &str) -> CandidateNode {
    CandidateNode {
        id: id.to_string(),
        role_id: 31,
        role: role.to_string(),
        name: name.to_string(),
        description: "Adversarial test description".to_string(),
        bounds: BoundingBox {
            x: 0.0,
            y: 0.0,
            width: 100.0,
            height: 30.0,
        },
        is_visible: true,
        has_default_action: true,
    }
}

#[test]
fn audit_vector_1_giant_string_poisoning() {
    // Un sitio web inyecta un aria-label malicioso de 100.000 caracteres
    let giant_poison = "configuracion ".repeat(10_000);
    let candidates = vec![
        create_adversarial_node(1, &giant_poison, "button"),
        create_adversarial_node(2, "Inicio", "link"),
    ];

    let start = Instant::now();
    let pruned = lexical_ranker::rank_and_prune("abrir configuracion", &candidates, 5);
    let elapsed = start.elapsed();

    println!("\n[AUDIT ADV-1] Tiempo de poda con string de 140.000 chars: {:.3} ms", elapsed.as_secs_f64() * 1000.0);

    // Debe resolver de inmediato sin colgar la CPU (<10ms)
    assert!(elapsed.as_secs_f64() * 1000.0 < 10.0);
    assert!(!pruned.is_empty());
}

#[test]
fn audit_vector_2_unicode_homoglyphs_and_injection() {
    // Inyección de caracteres de control, saltos de línea y homóglifos
    let evil_name = "сonfiguración\u{200B}\u{0000}\n\r\t-- DROP TABLE users; <script>alert(1)</script>";
    let candidates = vec![
        create_adversarial_node(1, evil_name, "button"),
    ];

    let pruned = lexical_ranker::rank_and_prune("configuracion", &candidates, 5);
    assert_eq!(pruned.len(), 1);

    // La normalización debe despojar caracteres de control sin romper el ranker
    let norm = lexical_ranker::normalize_text(evil_name);
    assert!(!norm.contains("<script>"));
    assert!(!norm.contains("\n"));
}

#[test]
fn audit_vector_3_malformed_json_resilience() {
    // Simular JSON corrupto o incompleto en el protocolo IPC
    let malformed_payloads = vec![
        r#"{"transcript": "test""#, // JSON truncado
        r#"{"transcript": 12345, "candidates": "invalid"}"#, // Tipos invertidos
        r#""#, // Cadena vacía
        r#"{"candidates": []}"#, // Falta transcript
    ];

    for payload in malformed_payloads {
        let res: Result<ClassifyRequest, _> = serde_json::from_str(payload);
        // Debe fallar de forma segura en serde sin generar un panic de runtime
        assert!(res.is_err());
    }
}
