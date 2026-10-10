// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

pub mod audio_capture;
pub mod audio_events;
pub mod ipc;
pub mod lexical_ranker;
pub mod nli_engine;
pub mod protocol;
pub mod stt;
pub mod vad;
pub mod vlm_engine;

use std::io::Write;

/// Log de depuración condicional activado por la variable de entorno ZEN_VOICE_ENGINE_LOG o por defecto en TEMP
pub fn log_debug(msg: &str) {
    let log_path = std::env::var("ZEN_VOICE_ENGINE_LOG").unwrap_or_else(|_| {
        let temp = std::env::temp_dir();
        temp.join("zen_voice_engine.log").to_string_lossy().to_string()
    });
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&log_path) {
        let _ = writeln!(f, "{}", msg);
    }
}
