// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

use serde::{Deserialize, Serialize};

/// Coordenadas de un elemento en píxeles CSS
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BoundingBox {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// Candidato interactivo provisto por ZenVoiceNavChild (AOM)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CandidateNode {
    pub id: String,
    pub role_id: u32,
    pub role: String,
    pub name: String,
    pub description: String,
    pub bounds: BoundingBox,
    pub is_visible: bool,
    pub has_default_action: bool,
}

/// Petición JSON-RPC recibida desde Zen Browser
#[derive(Debug, Clone, Deserialize)]
pub struct ClassifyRequest {
    pub transcript: String,
    pub candidates: Vec<CandidateNode>,
    #[serde(default = "default_top_k")]
    pub top_k: usize,
}

fn default_top_k() -> usize {
    10
}

/// Candidato puntuado por el filtro léxico de Fase 1 del pipeline
#[derive(Debug, Clone, Serialize)]
pub struct RankedCandidate {
    pub id: String,
    pub role: String,
    pub name: String,
    pub lexical_score: f64,
}

/// Decisión final devuelta a Zen Browser
#[derive(Debug, Clone, Serialize)]
pub struct ClassifyResult {
    pub matched_id: Option<String>,
    pub action: String,
    pub confidence: f64,
    pub fallback_to_vlm: bool,
    pub latency_ms: f64,
    pub candidate_count_in: usize,
    pub candidate_count_pruned: usize,
    pub tier: String,
}
