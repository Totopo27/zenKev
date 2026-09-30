use std::collections::VecDeque;

/// Configuración de captura y umbrales de voz
#[derive(Debug, Clone)]
pub struct VadConfig {
    pub sample_rate: usize,        // 16000 Hz estándar para Silero y Whisper
    pub chunk_size: usize,         // 512 muestras (~32 ms)
    pub speech_threshold: f32,     // Umbral de probabilidad [0.0 - 1.0]
    pub min_silence_duration_ms: usize, // Tiempo de silencio para cortar comando (~400 ms)
}

impl Default for VadConfig {
    fn default() -> Self {
        Self {
            sample_rate: 16000,
            chunk_size: 512,
            speech_threshold: 0.50,
            min_silence_duration_ms: 400,
        }
    }
}

/// Estado de la detección de voz
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum VoiceState {
    Silence,
    Speaking,
    SpeechEnded,
}

/// Detector de Actividad Vocal (VAD) y Controlador de Barge-In.
/// En producción, este struct envuelve la sesión ONNX de Silero VAD (C++ / ONNX Runtime).
pub struct VoiceActivityDetector {
    config: VadConfig,
    state: VoiceState,
    silence_samples_accumulated: usize,
    audio_buffer: Vec<f32>,
    history_ring: VecDeque<f32>,
}

impl VoiceActivityDetector {
    pub fn new(config: VadConfig) -> Self {
        Self {
            config,
            state: VoiceState::Silence,
            silence_samples_accumulated: 0,
            audio_buffer: Vec::with_capacity(16000 * 5), // Capacidad para ~5 segundos
            history_ring: VecDeque::with_capacity(16000), // Pre-roll de ~1 segundo
        }
    }

    /// Procesa un chunk de audio PCM de 16-bit / float (-1.0 a 1.0)
    /// Retorna: (Nuevo estado, Requiere Barge-in inmediato)
    pub fn process_chunk(&mut self, chunk: &[f32], model_probability: f32) -> (VoiceState, bool) {
        let is_speech = model_probability >= self.config.speech_threshold;
        let mut trigger_barge_in = false;

        // Mantener pre-roll circular para no perder las primeras consonantes
        for &sample in chunk {
            if self.history_ring.len() >= 16000 {
                self.history_ring.pop_front();
            }
            self.history_ring.push_back(sample);
        }

        match self.state {
            VoiceState::Silence => {
                if is_speech {
                    self.state = VoiceState::Speaking;
                    trigger_barge_in = true; // [BARGE-IN]: El usuario comenzó a hablar, silenciar salida

                    // Volcar pre-roll al buffer activo del comando
                    self.audio_buffer.clear();
                    self.audio_buffer.extend(self.history_ring.iter().cloned());
                    self.silence_samples_accumulated = 0;
                }
            }
            VoiceState::Speaking => {
                self.audio_buffer.extend_from_slice(chunk);

                if !is_speech {
                    self.silence_samples_accumulated += chunk.len();
                    let silence_threshold_samples =
                        (self.config.min_silence_duration_ms * self.config.sample_rate) / 1000;

                    if self.silence_samples_accumulated >= silence_threshold_samples {
                        self.state = VoiceState::SpeechEnded;
                    }
                } else {
                    self.silence_samples_accumulated = 0;
                }
            }
            VoiceState::SpeechEnded => {
                // Estado terminal transitorio: el orquestador toma el buffer y resetea el detector
            }
        }

        (self.state, trigger_barge_in)
    }

    /// Extrae el audio acumulado para enviarlo a Whisper y reinicia el estado
    pub fn drain_audio(&mut self) -> Vec<f32> {
        let audio = std::mem::replace(&mut self.audio_buffer, Vec::with_capacity(16000 * 5));
        self.state = VoiceState::Silence;
        self.silence_samples_accumulated = 0;
        audio
    }
}
