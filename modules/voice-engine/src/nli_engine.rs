use crate::protocol::RankedCandidate;
use std::io::{Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::time::Duration;

pub struct DecisionOutput {
    pub matched_id: Option<String>,
    pub action: String,
    pub confidence: f64,
    pub fallback_to_vlm: bool,
    pub tier: String, // "tier1_lexical" | "tier2_semantic" | "none"
}

/// Clúster semántico de conceptos web habituales para resolución de intenciones y sinónimos (Tier 2 local)
struct SemanticCluster {
    #[allow(dead_code)]
    concept: &'static str,
    terms: &'static [&'static str],
}

const SEMANTIC_CLUSTERS: &[SemanticCluster] = &[
    SemanticCluster {
        concept: "checkout_and_payment",
        terms: &["pagar", "comprar", "pago", "compra", "pedido", "adquirir", "facturacion", "tarjeta", "checkout", "caja", "abono", "finalizar compra", "tramitar pedido", "pay", "order"],
    },
    SemanticCluster {
        concept: "configuration_settings",
        terms: &["ajustes", "preferencias", "opciones", "personalizar", "perfil", "cuenta", "configuracion", "configuración", "settings", "setup", "options", "preferences"],
    },
    SemanticCluster {
        concept: "authentication_login",
        terms: &["entrar", "ingresar", "login", "acceder", "autenticar", "conectar", "conectar cuenta", "iniciar sesión", "iniciar sesion", "sign in", "acceso"],
    },
    SemanticCluster {
        concept: "authentication_logout",
        terms: &["salir", "desconectar", "terminar sesion", "logout", "abandonar", "desloguear", "cerrar sesión", "cerrar sesion", "sign out"],
    },
    SemanticCluster {
        concept: "bookmarks_and_favorites",
        terms: &["favoritos", "guardados", "links guardados", "guardar pagina", "marcadores", "bookmarks", "guardar en marcadores"],
    },
    SemanticCluster {
        concept: "downloads_and_files",
        terms: &["ficheros", "archivos", "bajar archivo", "descargas", "downloads", "instaladores", "descargar"],
    },
    SemanticCluster {
        concept: "history_navigation",
        terms: &["lo que visite", "paginas visitadas", "ayer", "sitios anteriores", "historial", "history"],
    },
    SemanticCluster {
        concept: "home_start",
        terms: &["portada", "principal", "volver al principio", "casa", "inicio", "home", "página principal"],
    },
    SemanticCluster {
        concept: "search_query",
        terms: &["encontrar", "localizar", "consultar", "rastrear", "averiguar", "buscar", "search", "búsqueda", "lupa"],
    },
    SemanticCluster {
        concept: "voice_panel",
        terms: &["vumetro", "control de voz", "microfono", "panel", "widget", "ventana flotante", "panel de voz", "zenkev"],
    },
];

/// Evaluador de Intención Semántica con Arquitectura Híbrida de Dos Niveles:
/// - Tier 1: Filtro léxico determinista ultrarrápido (<0.1ms).
/// - Tier 2: Fallback semántico (Local Concept Clusters o Servidor jaredpalmer/kev).
pub struct IntentClassifier {
    confidence_threshold: f64,
}

impl IntentClassifier {
    pub fn new(confidence_threshold: f64) -> Self {
        Self {
            confidence_threshold,
        }
    }

    /// Evalúa los candidatos previamente podados por el ranker léxico usando los dos niveles.
    pub fn evaluate(
        &self,
        transcript: &str,
        ranked: &[RankedCandidate],
    ) -> DecisionOutput {
        if ranked.is_empty() {
            return DecisionOutput {
                matched_id: None,
                action: "none".to_string(),
                confidence: 0.0,
                fallback_to_vlm: false,
                tier: "none".to_string(),
            };
        }

        let best = &ranked[0];

        // Caso 1: Botón mudo (sin nombre accesible o nombre genérico)
        if best.name.trim().is_empty() {
            return DecisionOutput {
                matched_id: Some(best.id.clone()),
                action: "inspect_visual".to_string(),
                confidence: best.lexical_score,
                fallback_to_vlm: true, // Se activa contingencia visual (Sistema 2)
                tier: "tier1_lexical".to_string(),
            };
        }

        // Verificación de ambigüedad léxica: si los 2 mejores tienen casi el mismo score
        let is_ambiguous = ranked.len() > 1
            && (best.lexical_score - ranked[1].lexical_score).abs() < 0.05
            && best.lexical_score < 0.70;

        // Caso 2: Tier 1 Léxico Exitoso (Alta confianza y sin ambigüedad)
        if best.lexical_score >= self.confidence_threshold && !is_ambiguous {
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
                tier: "tier1_lexical".to_string(),
            };
        }

        // Caso 3: Fallback a Tier 2 Semántico (Kev Endpoint o Local Semantic Matcher)
        if let Some((semantic_idx, semantic_conf)) = self.evaluate_semantic_fallback(transcript, ranked) {
            let target = &ranked[semantic_idx];
            let action = match target.role.as_str() {
                "entry" | "password_text" => "focus",
                "combobox" | "listbox" => "expand",
                _ => "click",
            };

            return DecisionOutput {
                matched_id: Some(target.id.clone()),
                action: action.to_string(),
                confidence: semantic_conf,
                fallback_to_vlm: false,
                tier: "tier2_semantic".to_string(),
            };
        }

        // Caso 4: No se pudo resolver con confianza suficiente ni en Tier 1 ni en Tier 2
        DecisionOutput {
            matched_id: Some(best.id.clone()),
            action: "confirm_intent".to_string(),
            confidence: best.lexical_score,
            fallback_to_vlm: best.lexical_score < 0.20,
            tier: "tier2_semantic".to_string(),
        }
    }

    /// Tier 2: Consulta primero al endpoint de jaredpalmer/kev si está configurado en el entorno;
    /// de lo contrario, aplica el emparejamiento semántico local mediante clusters de conceptos.
    fn evaluate_semantic_fallback(
        &self,
        transcript: &str,
        ranked: &[RankedCandidate],
    ) -> Option<(usize, f64)> {
        // 1. Probar endpoint de jaredpalmer/kev si ZEN_VOICE_KEV_ENDPOINT está activo
        if let Ok(endpoint) = std::env::var("ZEN_VOICE_KEV_ENDPOINT") {
            if !endpoint.trim().is_empty() {
                if let Some(res) = Self::query_kev_server(&endpoint, transcript, ranked) {
                    return Some(res);
                }
            }
        }

        // 2. Fallback semántico local determinista (Cero dependencias externas, <1ms)
        Self::evaluate_local_semantic(transcript, ranked)
    }

    /// Consulta HTTP rápida a un servidor compatible con jaredpalmer/kev (TypeSafe System One API)
    fn query_kev_server(
        endpoint: &str,
        transcript: &str,
        ranked: &[RankedCandidate],
    ) -> Option<(usize, f64)> {
        // Parsear host, port y path
        let url = endpoint.strip_prefix("http://").unwrap_or(endpoint);
        let mut parts = url.splitn(2, '/');
        let host_port = parts.next()?;
        let path = format!("/{}", parts.next().unwrap_or("choice"));

        let mut hp_parts = host_port.splitn(2, ':');
        let host = hp_parts.next()?;
        let port: u16 = hp_parts.next().and_then(|p| p.parse().ok()).unwrap_or(80);

        let addr = format!("{}:{}", host, port)
            .to_socket_addrs()
            .ok()?
            .next()?;

        // Privacy check: reject non-loopback endpoints unless explicitly allowed
        if !addr.ip().is_loopback() && std::env::var("ZEN_VOICE_ALLOW_REMOTE_ENDPOINT").as_deref() != Ok("1") {
            eprintln!(
                "[zenKev] Privacy warning: Refusing to send voice transcript to non-loopback endpoint '{}' ({}) without ZEN_VOICE_ALLOW_REMOTE_ENDPOINT=1",
                host_port, addr
            );
            return None;
        }

        let choices: Vec<&str> = ranked.iter().map(|r| r.name.as_str()).collect();
        let payload = serde_json::json!({
            "question": format!("El usuario ha dicho: '{}'. ¿Cuál de las opciones representa mejor la acción deseada?", transcript),
            "choices": choices
        });
        let body = serde_json::to_string(&payload).ok()?;

        let mut stream = TcpStream::connect_timeout(&addr, Duration::from_millis(150)).ok()?;

        stream.set_read_timeout(Some(Duration::from_millis(250))).ok()?;
        stream.set_write_timeout(Some(Duration::from_millis(150))).ok()?;

        let request = format!(
            "POST {} HTTP/1.1\r\nHost: {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            path, host, body.len(), body
        );

        stream.write_all(request.as_bytes()).ok()?;
        let mut response_buf = Vec::new();
        stream.read_to_end(&mut response_buf).ok()?;

        let resp_str = String::from_utf8_lossy(&response_buf);
        let json_start = resp_str.find("\r\n\r\n")? + 4;
        let json_body = &resp_str[json_start..];

        let parsed: serde_json::Value = serde_json::from_str(json_body).ok()?;
        let choice_idx = parsed.get("choice").and_then(|c| c.as_u64())? as usize;
        let confidence = parsed.get("confidence").and_then(|c| c.as_f64()).unwrap_or(0.85);

        if choice_idx < ranked.len() {
            Some((choice_idx, confidence))
        } else {
            None
        }
    }

    /// Evaluador semántico local basado en clusters de conceptos y sinonimia web
    fn evaluate_local_semantic(
        transcript: &str,
        ranked: &[RankedCandidate],
    ) -> Option<(usize, f64)> {
        let clean_t = transcript.to_lowercase();
        let t_words: Vec<&str> = clean_t.split_whitespace().collect();

        let mut best_idx = None;
        let mut best_score = 0.0;

        for (idx, candidate) in ranked.iter().enumerate() {
            let cand_name = candidate.name.to_lowercase();
            let cand_words: Vec<&str> = cand_name.split_whitespace().collect();
            let mut score: f64 = candidate.lexical_score * 0.3; // Base léxica ponderada

            // Evaluar afinidad con cada cluster semántico
            for cluster in SEMANTIC_CLUSTERS {
                let matches_transcript = cluster.terms.iter().any(|&term| {
                    t_words.iter().any(|&w| w == term || (term.len() > 3 && w.starts_with(term)))
                        || clean_t.contains(term)
                });

                if matches_transcript {
                    let matches_candidate = cluster.terms.iter().any(|&term| {
                        cand_words.iter().any(|&w| w == term || (term.len() > 3 && w.starts_with(term)))
                            || cand_name.contains(term)
                            || strsim::jaro_winkler(&cand_name, term) > 0.80
                    });

                    if matches_candidate {
                        score += 0.65; // Fuerte bonificación semántica por pertenecer al mismo concepto
                    }
                }
            }

            // Normalizar a rango [0.0, 1.0]
            if score > 1.0 {
                score = 1.0;
            }

            if score > best_score {
                best_score = score;
                best_idx = Some(idx);
            }
        }

        if let Some(idx) = best_idx {
            if best_score >= 0.40 {
                return Some((idx, best_score));
            }
        }

        None
    }
}
