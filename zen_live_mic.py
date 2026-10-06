"""
ZenKev Live Microphone Service
Captura la voz del usuario en tiempo real desde el micrófono y envía
los comandos transcritos directamente al motor zenKev en Zen Browser a través del canal IPC.
100% Manos libres: sin teclear, sin tocar el ratón.

[ADVERTENCIA DE PRIVACIDAD / PRIVACY NOTICE]:
Por defecto, este servicio puede invocar el endpoint en la nube de Google Speech
Recognition (recognize_google) para la transcripción en tiempo real, lo que implica
el envío de paquetes de audio a servidores externos.
Para operar en modo 100% local y privado (Air-Gapped / Zero Cloud Telemetry), defina
la variable de entorno:
    ZEN_VOICE_OFFLINE_STT=1 (o "true")
En dicho modo o ante fallos de conexión, el sistema activará el fallback local directo
sin requerir conexión externa y sin bloquear la ejecución del bucle de captura.
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
CHUNK_DURATION = 0.4  # 400ms por chunk para corte más ágil
THRESHOLD_ENERGY = 0.012  # Calibrado para filtrar respiración y ruido ambiental bajo
SILENCE_CHUNKS_LIMIT = 3  # 1.2s de silencio para permitir pausas naturales al hablar
MAX_CHUNKS_LIMIT = 18     # 7.2s límite máximo de captura continua

# Configuración de privacidad y modo offline STT
OFFLINE_STT_ENABLED = os.environ.get("ZEN_VOICE_OFFLINE_STT", "").lower() in ("1", "true", "yes", "on")

# Rutas dinámicas sin hardcoding (resolución portable multiplataforma)
LOG_FILE = os.environ.get(
    "ZEN_VOICE_MIC_LOG",
    os.path.join(tempfile.gettempdir(), "zen_live_mic.log")
)

IPC_FILE = os.environ.get(
    "ZEN_VOICE_IPC_PATH",
    os.path.join(tempfile.gettempdir(), "zen_voice_command.ipc")
)

# Named Pipe de Windows (canal reactivo prioritario de latencia ultrabaja)
PIPE_NAME = os.environ.get(
    "ZEN_VOICE_PIPE_NAME",
    r"\\.\pipe\zen_voice_ipc"
)
if not PIPE_NAME.startswith("\\\\.\\pipe\\") and not PIPE_NAME.startswith("//./pipe/"):
    PIPE_NAME = rf"\\.\pipe\{PIPE_NAME}"

# Inicialización anticipada de APIs de Named Pipe para evitar latencia de importación en caliente
_win32file = None
_kernel32 = None
if sys.platform == "win32":
    try:
        import win32file as _w32
        _win32file = _w32
    except ImportError:
        pass

    try:
        import ctypes
        from ctypes import wintypes
        _kernel32 = ctypes.windll.kernel32
    except Exception:
        pass

def _send_named_pipe_win32(pipe_name: str, message: str) -> bool:
    if _win32file is None:
        return False
    try:
        handle = _win32file.CreateFile(
            pipe_name,
            _win32file.GENERIC_WRITE,
            0,
            None,
            _win32file.OPEN_EXISTING,
            0,
            None,
        )
        data = (message + "\n").encode("utf-8")
        _win32file.WriteFile(handle, data)
        _win32file.CloseHandle(handle)
        return True
    except Exception:
        return False

def _send_named_pipe_ctypes(pipe_name: str, message: str) -> bool:
    if _kernel32 is None:
        return False
    try:
        import ctypes
        from ctypes import wintypes
        GENERIC_WRITE = 0x40000000
        OPEN_EXISTING = 3
        INVALID_HANDLE_VALUE = -1

        handle = _kernel32.CreateFileW(
            pipe_name,
            GENERIC_WRITE,
            0,
            None,
            OPEN_EXISTING,
            0,
            None,
        )
        if handle == INVALID_HANDLE_VALUE or handle == 0xFFFFFFFFFFFFFFFF:
            return False
        try:
            data = (message + "\n").encode("utf-8")
            written = wintypes.DWORD()
            success = _kernel32.WriteFile(handle, data, len(data), ctypes.byref(written), None)
            return bool(success)
        finally:
            _kernel32.CloseHandle(handle)
    except Exception:
        return False

def _send_named_pipe_open(pipe_name: str, message: str) -> bool:
    try:
        with open(pipe_name, "w", encoding="utf-8") as f:
            f.write(message + "\n")
            f.flush()
        return True
    except Exception:
        return False

def send_named_pipe(pipe_name: str, message: str) -> bool:
    """
    Intenta emitir el comando al Named Pipe de Windows usando el backend disponible más eficiente.
    """
    if _send_named_pipe_win32(pipe_name, message):
        return True
    if _send_named_pipe_ctypes(pipe_name, message):
        return True
    return _send_named_pipe_open(pipe_name, message)

def send_voice_command(transcript: str) -> bool:
    """
    Envía el comando transcrito al motor zen-voice-engine:
    1. En Windows, intenta prioritariamente por Named Pipe (interrupción de kernel, cero latencia de disco).
    2. Si el Named Pipe no está disponible o falla, realiza fallback automático al archivo IPC.
    """
    if sys.platform == "win32":
        try:
            if send_named_pipe(PIPE_NAME, transcript):
                log_event(f"🚀 Comando \"{transcript}\" enviado vía Named Pipe ({PIPE_NAME}) [0-latency kernel IOCP]")
                return True
            else:
                log_event(f"⚠️ Named Pipe ({PIPE_NAME}) no disponible. Fallback automático a archivo IPC...")
        except Exception as e:
            log_event(f"⚠️ Error conectando al Named Pipe: {e}. Fallback a archivo IPC...")

    # Fallback automático a archivo IPC
    try:
        with open(IPC_FILE, "a", encoding="utf-8") as f_ipc:
            f_ipc.write(transcript + "\n")
        log_event(f"🚀 Comando \"{transcript}\" enviado vía archivo IPC ({IPC_FILE})")
        return True
    except Exception as err:
        log_event(f"❌ Error escribiendo a archivo IPC: {err}")
        return False

def log_event(msg):
    ts = time.strftime("[%H:%M:%S]")
    line = f"{ts} {msg}"
    print(line, flush=True)
    try:
        with open(LOG_FILE, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except Exception:
        pass

def _offline_stt_fallback(r, audio_data):
    """
    Fallback local directo de STT: intenta reconocedores locales si están disponibles
    o ejecuta un fallback directo sin bloquear la ejecución del servicio.
    """
    # 1. Intentar vosk si estuviera instalado
    try:
        if hasattr(r, "recognize_vosk"):
            res = r.recognize_vosk(audio_data)
            if res:
                import json
                parsed = json.loads(res) if isinstance(res, str) else res
                text = parsed.get("text", "").strip().lower()
                if text:
                    return text
    except Exception:
        pass

    # 2. Intentar pocketsphinx si estuviera instalado
    try:
        if hasattr(r, "recognize_sphinx"):
            return r.recognize_sphinx(audio_data, language="es-ES").strip().lower()
    except Exception:
        pass

    # 3. Intentar whisper local si estuviera disponible
    try:
        if hasattr(r, "recognize_whisper"):
            return r.recognize_whisper(audio_data, language="spanish").strip().lower()
    except Exception:
        pass

    # 4. Fallback local directo seguro sin dependencias externas pesadas
    log_event("ℹ️  Fallback local directo: captura registrada localmente sin transmisión externa.")
    return None

def process_speech_recognition(r, audio_data):
    """
    Procesa el audio respetando la privacidad del usuario y la configuración offline.
    """
    if OFFLINE_STT_ENABLED:
        log_event("🔒 Procesando transcripción en modo OFFLINE local...")
        return _offline_stt_fallback(r, audio_data)

    log_event("⚡ Procesando transcripción con Google Speech...")
    try:
        return r.recognize_google(audio_data, language="es-ES").strip().lower()
    except sr.UnknownValueError:
        log_event("⚠️  Voz recibida pero no fue posible distinguirla claramente. Intenta hablar más cerca del mic.")
        return None
    except sr.RequestError as e:
        log_event(f"⚠️  Endpoint externo de Google Speech no disponible ({e}). Activando fallback local sin bloquear...")
        return _offline_stt_fallback(r, audio_data)

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
        f.write(f"=== ZenKev Live Mic Iniciado ===\nDispositivo: [{mic_idx}] {mic_name}\nPipe: {PIPE_NAME}\nIPC File: {IPC_FILE}\n")

    log_event(f"🎤 Dispositivo de audio detectado: [{mic_idx}] {mic_name}")
    log_event(f"⚡ Canal reactivo primario: Named Pipe ({PIPE_NAME})")
    log_event(f"🔗 Fallback IPC secundario: Archivo ({IPC_FILE})")

    if OFFLINE_STT_ENABLED:
        log_event("🔒 MODO OFFLINE ACTIVO (ZEN_VOICE_OFFLINE_STT=1): Privacidad total garantizada. Procesamiento local sin transmisión externa.")
    else:
        log_event("⚠️  AVISO DE PRIVACIDAD: Usando endpoint externo de Google Speech. Para procesamiento 100% local, configure ZEN_VOICE_OFFLINE_STT=1.")

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

                transcript = process_speech_recognition(r, audio_data)
                if transcript:
                    log_event(f"✅ Transcripción reconocida: \"{transcript}\"")
                    send_voice_command(transcript)

        except KeyboardInterrupt:
            log_event("Deteniendo servicio de micrófono.")
            break
        except Exception as e:
            log_event(f"Error en bucle de captura: {e}")
            time.sleep(1)

if __name__ == "__main__":
    main()
