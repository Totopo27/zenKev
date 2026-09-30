/// Configuración de inferencia Whisper
#[derive(Debug, Clone)]
pub struct WhisperConfig {
    pub language: String,       // "es" por defecto, o "auto"
    pub threads: usize,         // Hilos de CPU con AVX2
    pub max_tokens: usize,
    pub single_segment: bool,   // true para comandos directos
}

impl Default for WhisperConfig {
    fn default() -> Self {
        Self {
            language: "es".to_string(),
            threads: 4,
            max_tokens: 32,
            single_segment: true,
        }
    }
}

/// Transcriptor Streaming basado en Whisper.cpp (CPU)
#[allow(dead_code)]
pub struct SpeechToTextEngine {
    config: WhisperConfig,
}

impl SpeechToTextEngine {
    pub fn new(config: WhisperConfig) -> Self {
        Self { config }
    }

    /// Transcribe el buffer de audio PCM flotante (16kHz mono)
    /// En producción, este método alimenta `whisper_full` de whisper.cpp
    pub fn transcribe(&self, audio_samples: &[f32]) -> anyhow::Result<String> {
        if audio_samples.is_empty() {
            return Ok(String::new());
        }

        // Validación de duración mínima (al menos 200 ms de audio)
        let duration_ms = (audio_samples.len() as f64 / 16000.0) * 1000.0;
        if duration_ms < 200.0 {
            return Ok(String::new());
        }

        // Simulación controlada del paso Whisper para benchmarks de pipeline
        Ok("configuracion".to_string())
    }
}
