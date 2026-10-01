use crate::protocol::{CandidateNode, RankedCandidate};
use strsim::sorensen_dice;

/// Normaliza texto para comparación acústica/lingüística en español e inglés:
/// - Pasa a minúsculas
/// - Remueve acentos/diacríticos comunes
/// - Remueve caracteres no alfanuméricos redundantes
pub fn normalize_text(input: &str) -> String {
    // Protección contra DoS / String Poisoning: limitar a 512 bytes seguros
    let bounded = if input.len() > 512 {
        let mut end = 512;
        while !input.is_char_boundary(end) {
            end -= 1;
        }
        &input[..end]
    } else {
        input
    };

    bounded
        .to_lowercase()
        .chars()
        .map(|c| match c {
            'á' | 'à' | 'ä' => 'a',
            'é' | 'è' | 'ë' => 'e',
            'í' | 'ì' | 'ï' => 'i',
            'ó' | 'ò' | 'ö' => 'o',
            'ú' | 'ù' | 'ü' => 'u',
            other => other,
        })
        .filter(|c| c.is_alphanumeric() || c.is_whitespace())
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

/// Filtro léxico ultra-rápido (<1ms en CPU).
/// Reduce un conjunto grande de candidatos (ej. 300) a los `top_k` (ej. 10)
/// con mayor similitud frente a la transcripción del usuario.
pub fn rank_and_prune(
    transcript: &str,
    candidates: &[CandidateNode],
    top_k: usize,
) -> Vec<RankedCandidate> {
    let norm_transcript = normalize_text(transcript);
    let transcript_words: Vec<&str> = norm_transcript.split_whitespace().collect();

    let mut scored: Vec<RankedCandidate> = candidates
        .iter()
        .map(|node| {
            let norm_name = normalize_text(&node.name);
            let norm_desc = normalize_text(&node.description);

            // 1. Similitud global de bigramas/trigramas (Sørensen-Dice)
            let name_sim = if !norm_name.is_empty() {
                sorensen_dice(&norm_transcript, &norm_name)
            } else {
                0.0
            };

            // 2. Coincidencia directa de palabras clave contenidas
            let mut word_overlap = 0.0;
            if !norm_name.is_empty() {
                let matches = transcript_words
                    .iter()
                    .filter(|&&w| norm_name.contains(w) || norm_desc.contains(w))
                    .count();
                if !transcript_words.is_empty() {
                    word_overlap = matches as f64 / transcript_words.len() as f64;
                }
            }

            // 3. Ponderación combinada
            // 70% Sørensen-Dice + 30% solapamiento léxico de tokens
            let combined_score = (name_sim * 0.7) + (word_overlap * 0.3);

            RankedCandidate {
                id: node.id.clone(),
                role: node.role.clone(),
                name: node.name.clone(),
                lexical_score: combined_score,
            }
        })
        .collect();

    // Ordenar de mayor a menor puntuación
    scored.sort_by(|a, b| {
        b.lexical_score
            .partial_cmp(&a.lexical_score)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    // Retener únicamente los top_k elementos
    scored.truncate(top_k);
    scored
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::BoundingBox;

    fn make_node(id: &str, name: &str, role: &str) -> CandidateNode {
        CandidateNode {
            id: id.to_string(),
            role_id: 31,
            role: role.to_string(),
            name: name.to_string(),
            description: String::new(),
            bounds: BoundingBox { x: 0.0, y: 0.0, width: 50.0, height: 20.0 },
            is_visible: true,
            has_default_action: true,
        }
    }

    #[test]
    fn test_pruning_accuracy() {
        let candidates = vec![
            make_node("1", "Inicio", "link"),
            make_node("2", "Configuración de la cuenta", "button"),
            make_node("3", "Cerrar sesión", "button"),
            make_node("4", "Buscar productos", "entry"),
            make_node("5", "Notificaciones de usuario", "link"),
        ];

        let pruned = rank_and_prune("abrir configuración", &candidates, 2);
        assert_eq!(pruned.len(), 2);
        assert_eq!(pruned[0].id, "2"); // Debe seleccionar "Configuración" como primer puesto
    }
}
