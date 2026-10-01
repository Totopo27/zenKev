"""
ZenKev Live Microphone Service
Captura la voz del usuario en tiempo real desde el micrófono y envía
los comandos transcritos directamente al motor zenKev en Zen Browser a través del canal IPC.
100% Manos libres: sin teclear, sin tocar el ratón.
"""

import os
import sys
import time
import tempfile
import numpy as np
import sounddevice as sd
import speech_recognition as sr

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

SAMPLE_RATE = 16000
CHUNK_DURATION = 0.5  # segundos por chunk
THRESHOLD_ENERGY = 0.007  # Sensibilidad óptima calibrada para micrófono físico
SILENCE_CHUNKS_LIMIT = 2  # 1.0 segundo de silencio consecutivo para cortar frase (2 chunks de 0.5s)
MAX_CHUNKS_LIMIT = 14     # 7.0 segundos límite máximo de captura continua

# Rutas dinámicas sin hardcoding (resolución portable multiplataforma)
LOG_FILE = os.environ.get(
    "ZEN_VOICE_MIC_LOG",
    os.path.join(tempfile.gettempdir(), "zen_live_mic.log")
)

IPC_FILE = os.environ.get(
    "ZEN_VOICE_IPC_PATH",
    os.path.join(tempfile.gettempdir(), "zen_voice_command.ipc")
)

def log_event(msg):
    ts = time.strftime("[%H:%M:%S]")
    line = f"{ts} {msg}"
    print(line, flush=True)
    try:
        with open(LOG_FILE, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except Exception:
        pass

def find_best_mic():
    """Detecta de forma dinámica el micrófono activo más adecuado evitando mezclas estéreo."""
    devices = sd.query_devices()

    # 1. Buscar micrófono físico preferente por palabras clave
    for i, d in enumerate(devices):
        if d['max_input_channels'] > 0:
            name = d['name'].lower()
            if any(skip in name for skip in ['mapper', 'controlador primario', 'mezcla', 'stereo mix', 'línea de entrada']):
                continue
            if 'micr' in name or 'realtek' in name or 'logitech' in name or 'c925' in name or 'usb' in name:
                try:
                    with sd.InputStream(device=i, channels=1, samplerate=SAMPLE_RATE, dtype='float32') as s:
                        data, _ = s.read(800)
                        return i, d['name']
                except Exception:
                    continue

    # 2. Fallback: primer dispositivo de entrada funcional que no sea mezcla estéreo
    for i, d in enumerate(devices):
        if d['max_input_channels'] > 0:
            name = d['name'].lower()
            if any(skip in name for skip in ['mezcla', 'stereo mix']):
                continue
            try:
                with sd.InputStream(device=i, channels=1, samplerate=SAMPLE_RATE, dtype='float32') as s:
                    data, _ = s.read(800)
                    return i, d['name']
            except Exception:
                continue

    # 3. Fallback al dispositivo por defecto del sistema
    default_idx = sd.default.device[0]
    if default_idx is not None and default_idx >= 0 and default_idx < len(devices):
        return default_idx, devices[default_idx]['name']

    return 0, "Default Input Device"

def main():
    mic_idx, mic_name = find_best_mic()
    with open(LOG_FILE, "w", encoding="utf-8") as f:
        f.write(f"=== ZenKev Live Mic Iniciado ===\nDispositivo: [{mic_idx}] {mic_name}\nIPC File: {IPC_FILE}\n")

    log_event(f"🎤 Dispositivo de audio detectado: [{mic_idx}] {mic_name}")
    log_event(f"🔗 Cola IPC conectada en: {IPC_FILE}")

    r = sr.Recognizer()
    r.dynamic_energy_threshold = True

    print("\n" + "="*60)
    print("🎤 ZENKEV MANOS LIBRES ACTIVO Y ESCUCHANDO...")
    print("Habla claramente a tu micrófono diciendo cualquier comando:")
    print("  - 'inicio'")
    print("  - 'guardar cambios' o 'guardar'")
    print("  - 'configuración'")
    print("  - 'descargas' o 'historial'")
    print("  - 'wikipedia'")
    print("  - 'cancelar'")
    print("="*60 + "\n", flush=True)

    chunk_samples = int(SAMPLE_RATE * CHUNK_DURATION)

    while True:
        try:
            audio_buffer = []
            speaking = False
            silence_count = 0

            with sd.InputStream(device=mic_idx, channels=1, samplerate=SAMPLE_RATE, dtype='float32') as stream:
                while True:
                    data, _ = stream.read(chunk_samples)
                    rms = np.sqrt(np.mean(data**2))

                    if rms > THRESHOLD_ENERGY:
                        if not speaking:
                            speaking = True
                            log_event("🗣️  Voz detectada... escuchando comando...")
                        audio_buffer.append(data.copy())
                        silence_count = 0
                    elif speaking:
                        audio_buffer.append(data.copy())
                        silence_count += 1
                        if silence_count >= SILENCE_CHUNKS_LIMIT or len(audio_buffer) >= MAX_CHUNKS_LIMIT:
                            break

            if audio_buffer:
                full_audio = np.concatenate(audio_buffer, axis=0)
                max_val = np.max(np.abs(full_audio))
                if max_val > 0.001:
                    gain = min(0.85 / max_val, 12.0)
                    normalized_audio = full_audio * gain
                else:
                    normalized_audio = full_audio
                pcm16 = (np.clip(normalized_audio, -1.0, 1.0) * 32767).astype(np.int16)
                audio_data = sr.AudioData(pcm16.tobytes(), SAMPLE_RATE, 2)

                log_event("⚡ Procesando transcripción con Google Speech...")
                try:
                    transcript = r.recognize_google(audio_data, language="es-ES").strip().lower()
                    log_event(f"✅ Transcripción reconocida: \"{transcript}\"")

                    try:
                        with open(IPC_FILE, "a", encoding="utf-8") as f_ipc:
                            f_ipc.write(transcript + "\n")
                    except Exception as err:
                        log_event(f"Error escribiendo a IPC: {err}")

                    log_event(f"🚀 Comando \"{transcript}\" enviado a Zen Browser (IPC)")
                except sr.UnknownValueError:
                    log_event("⚠️  Voz recibida pero no fue posible distinguirla claramente. Intenta hablar más cerca del mic.")
                except sr.RequestError as e:
                    log_event(f"❌ Error en servicio de reconocimiento: {e}")

        except KeyboardInterrupt:
            log_event("Deteniendo servicio de micrófono.")
            break
        except Exception as e:
            log_event(f"Error en bucle de captura: {e}")
            time.sleep(1)

if __name__ == "__main__":
    main()
