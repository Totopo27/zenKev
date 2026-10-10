// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

//! Captura de audio en tiempo real desde el dispositivo del sistema (micrófono)
//! usando CPAL (WASAPI en Windows, ALSA/Pulse en Linux, CoreAudio en macOS).
//! Integra VAD (Voice Activity Detection) para segmentar el audio y evitar enviar silencio.

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::StreamConfig;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::Duration;
use crate::vad::{VadConfig, VoiceActivityDetector, VoiceState};

pub struct AudioCapture {
    is_running: Arc<AtomicBool>,
}

impl AudioCapture {
    pub fn new() -> Self {
        Self {
            is_running: Arc::new(AtomicBool::new(false)),
        }
    }

    /// Comprueba si la captura de audio está activa actualmente.
    pub fn is_running(&self) -> bool {
        self.is_running.load(Ordering::SeqCst)
    }

    /// Detiene la captura de audio.
    pub fn stop(&self) {
        self.is_running.store(false, Ordering::SeqCst);
    }

    /// Inicia la captura de audio en un hilo de fondo dedicado.
    /// Cuando detecta habla completa (SpeechEnded tras VAD), invoca `on_speech_ready`.
    pub fn start<F>(&self, on_speech_ready: F) -> anyhow::Result<()>
    where
        F: Fn(Vec<f32>) + Send + Sync + 'static,
    {
        if self.is_running.swap(true, Ordering::SeqCst) {
            // Ya estaba corriendo
            return Ok(());
        }

        let is_running_clone = Arc::clone(&self.is_running);
        let on_speech_ready = Arc::new(on_speech_ready);

        thread::Builder::new()
            .name("zen-audio-capture".to_string())
            .spawn(move || {
                if let Err(e) = run_capture_loop(is_running_clone, on_speech_ready) {
                    eprintln!("[zen-voice-engine] Error en captura de audio: {:?}", e);
                }
            })?;

        Ok(())
    }
}

fn run_capture_loop<F>(is_running: Arc<AtomicBool>, on_speech_ready: Arc<F>) -> anyhow::Result<()>
where
    F: Fn(Vec<f32>) + Send + Sync + 'static,
{
    let host = cpal::default_host();
    let device = match host.default_input_device() {
        Some(d) => d,
        None => {
            anyhow::bail!("No se detectó ningún dispositivo de entrada de audio predeterminado");
        }
    };

    let device_name = match device.description() {
        Ok(desc) => format!("{:?}", desc),
        Err(_) => "desconocido".to_string(),
    };
    crate::log_debug(&format!("[AudioCapture] Dispositivo de entrada seleccionado: '{}'", device_name));

    let default_config = device.default_input_config()?;
    let sample_rate = default_config.sample_rate();
    let channels = default_config.channels() as usize;
    crate::log_debug(&format!("[AudioCapture] Configuración de stream: rate={}Hz, channels={}", sample_rate, channels));

    let (tx, rx) = std::sync::mpsc::sync_channel::<Vec<f32>>(200);

    let err_fn = |err| eprintln!("[zen-voice-engine] Error en stream de audio: {}", err);

    let config = StreamConfig {
        channels: default_config.channels(),
        sample_rate,
        buffer_size: cpal::BufferSize::Default,
    };

    let stream = match default_config.sample_format() {
        cpal::SampleFormat::F32 => {
            let tx = tx.clone();
            device.build_input_stream(
                config,
                move |data: &[f32], _: &cpal::InputCallbackInfo| {
                    let mono: Vec<f32> = if channels > 1 {
                        data.chunks(channels).map(|frame| frame[0]).collect()
                    } else {
                        data.to_vec()
                    };
                    let _ = tx.try_send(mono);
                },
                err_fn,
                None,
            )?
        }
        cpal::SampleFormat::I16 => {
            let tx = tx.clone();
            device.build_input_stream(
                config,
                move |data: &[i16], _: &cpal::InputCallbackInfo| {
                    let mono: Vec<f32> = if channels > 1 {
                        data.chunks(channels).map(|frame| frame[0] as f32 / 32768.0).collect()
                    } else {
                        data.iter().map(|&s| s as f32 / 32768.0).collect()
                    };
                    let _ = tx.try_send(mono);
                },
                err_fn,
                None,
            )?
        }
        cpal::SampleFormat::U16 => {
            let tx = tx.clone();
            device.build_input_stream(
                config,
                move |data: &[u16], _: &cpal::InputCallbackInfo| {
                    let mono: Vec<f32> = if channels > 1 {
                        data.chunks(channels).map(|frame| (frame[0] as f32 - 32768.0) / 32768.0).collect()
                    } else {
                        data.iter().map(|&s| (s as f32 - 32768.0) / 32768.0).collect()
                    };
                    let _ = tx.try_send(mono);
                },
                err_fn,
                None,
            )?
        }
        _ => anyhow::bail!("Formato de muestra de audio no soportado"),
    };

    stream.play()?;
    crate::log_debug("[AudioCapture] Stream de captura CPAL/WASAPI iniciado con éxito (stream.play)");

    let vad_config = VadConfig {
        sample_rate: 16000,
        chunk_size: 512,
        speech_threshold: 0.50,
        min_silence_duration_ms: 450,
    };
    let mut vad = VoiceActivityDetector::new(vad_config);

    let mut resample_buffer = Vec::new();
    let target_rate = 16000;
    let actual_rate = sample_rate;

    while is_running.load(Ordering::SeqCst) {
        match rx.recv_timeout(Duration::from_millis(50)) {
            Ok(samples) => {
                if actual_rate == target_rate {
                    resample_buffer.extend(samples);
                } else {
                    let ratio = actual_rate as f64 / target_rate as f64;
                    let num_target_samples = (samples.len() as f64 / ratio) as usize;
                    for i in 0..num_target_samples {
                        let orig_idx = (i as f64 * ratio) as usize;
                        if orig_idx < samples.len() {
                            resample_buffer.push(samples[orig_idx]);
                        }
                    }
                }

                while resample_buffer.len() >= 512 {
                    let chunk: Vec<f32> = resample_buffer.drain(0..512).collect();
                    
                    let energy = (chunk.iter().map(|&s| s * s).sum::<f32>() / chunk.len() as f32).sqrt();
                    let speech_prob = if energy > 0.012 { 0.95 } else { 0.05 };

                    let (state, _barge_in) = vad.process_chunk(&chunk, speech_prob);

                    if state == VoiceState::SpeechEnded {
                        let audio = vad.drain_audio();
                        if !audio.is_empty() {
                            crate::log_debug(&format!("[AudioCapture] SpeechEnded detectado por VAD. Muestras acumuladas: {}", audio.len()));
                            (on_speech_ready)(audio);
                        }
                    }
                }
            }
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                continue;
            }
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                break;
            }
        }
    }

    drop(stream);
    Ok(())
}
