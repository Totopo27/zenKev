use crate::protocol::RankedCandidate;

pub struct DecisionOutput {
    pub matched_id: Option<String>,
    pub action: String,
    pub confidence: f64,
    pub fallback_to_vlm: bool,
}

/// Evaluador de Intención Semántica.
/// En producción, este componente ejecuta el modelo ModernBERT NLI compilado con ONNX Runtime.
/// Para el pipeline base, implementa la resolución de umbrales y decisión de fallback a Sistema 2.
pub struct IntentClassifier {
    confidence_threshold: f64,
}

impl IntentClassifier {
    pub fn new(confidence_threshold: f64) -> Self {
        Self {
            confidence_threshold,
        }
    }

    /// Evalúa los candidatos previamente podados por el ranker léxico.
    pub fn evaluate(
        &self,
        _transcript: &str,
        ranked: &[RankedCandidate],
    ) -> DecisionOutput {
        if ranked.is_empty() {
            return DecisionOutput {
                matched_id: None,
                action: "none".to_string(),
                confidence: 0.0,
                fallback_to_vlm: false,
            };
        }

        let best = &ranked[0];

        // Caso 1: Botón mudo (sin nombre accesible o nombre genérico)
        if best.name.trim().is_empty() {
            return DecisionOutput {
                matched_id: Some(best.id.clone()),
                action: "inspect_visual".to_string(),
                confidence: best.lexical_score,
                fallback_to_vlm: true, // Se activa contingencia Sistema 2
            };
        }

        // Caso 2: Confianza supera el umbral determinista (Sistema 1 exitoso)
        if best.lexical_score >= self.confidence_threshold {
            let action = match best.role.as_str() {
                "entry" | "password_text" => "focus",
                "combobox" | "listbox" => "expand",
                _ => "click", // pushbutton, link, switch, checkbox, etc.
            };

            return DecisionOutput {
                matched_id: Some(best.id.clone()),
                action: action.to_string(),
                confidence: best.lexical_score,
                fallback_to_vlm: false,
            };
        }

        // Caso 3: Ambigüedad o baja confianza
        // Si hay una diferencia muy pequeña entre el puesto 1 y el 2, o confianza < threshold
        DecisionOutput {
            matched_id: Some(best.id.clone()),
            action: "confirm_intent".to_string(),
            confidence: best.lexical_score,
            fallback_to_vlm: best.lexical_score < 0.2,
        }
    }
}
