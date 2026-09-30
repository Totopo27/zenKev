use serde::{Deserialize, Serialize};

/// Evento de control asíncrono emitido por el motor de audio hacia Zen Browser
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum AudioControlEvent {
    /// Disparado en <= 20ms cuando Silero VAD detecta voz: silenciar el sintetizador TTS
    #[serde(rename = "barge_in")]
    BargeIn,

    /// Disparado cuando el usuario termina de hablar y el audio pasa a Whisper
    #[serde(rename = "transcribing")]
    Transcribing,

    /// Transcripción final completada
    #[serde(rename = "transcription_ready")]
    TranscriptionReady { text: String, duration_ms: f64 },
}
