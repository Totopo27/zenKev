#!/usr/bin/env python3
"""
Test de verificación E2E para el canal reactivo de Named Pipes entre Python y zen-voice-engine.
Verifica:
1. Conexión reactiva por Named Pipe sin polling en disco.
2. Emisión instantánea (< 15ms) del evento `transcription_ready` en stdout.
3. Fallback automático a archivo cuando el pipe no está disponible.
"""

import os
import sys
import time
import subprocess
import threading
import json
import tempfile

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

PIPE_NAME = rf"\\.\pipe\zen_e2e_test_{os.getpid()}"
ENGINE_BIN = os.path.abspath(os.path.join(
    os.path.dirname(__file__),
    "../target/release/zen-voice-engine.exe"
))

if not os.path.exists(ENGINE_BIN):
    ENGINE_BIN = os.path.abspath(os.path.join(
        os.path.dirname(__file__),
        "../target/debug/zen-voice-engine.exe"
    ))

try:
    import win32file
except ImportError:
    win32file = None

def send_named_pipe(pipe_name: str, message: str) -> bool:
    """Envía un comando al Named Pipe de Windows usando win32file o ctypes."""
    if win32file is not None:
        try:
            handle = win32file.CreateFile(
                pipe_name,
                win32file.GENERIC_WRITE,
                0,
                None,
                win32file.OPEN_EXISTING,
                0,
                None,
            )
            data = (message + "\n").encode("utf-8")
            win32file.WriteFile(handle, data)
            win32file.CloseHandle(handle)
            return True
        except Exception:
            pass

    try:
        import ctypes
        from ctypes import wintypes
        kernel32 = ctypes.windll.kernel32
        GENERIC_WRITE = 0x40000000
        OPEN_EXISTING = 3
        INVALID_HANDLE_VALUE = -1

        handle = kernel32.CreateFileW(
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
            success = kernel32.WriteFile(handle, data, len(data), ctypes.byref(written), None)
            return bool(success)
        finally:
            kernel32.CloseHandle(handle)
    except Exception:
        return False

def main():
    print(f"=== [TEST E2E] Verificación de Named Pipe Reactivo: {PIPE_NAME} ===")
    print(f"Binario zen-voice-engine: {ENGINE_BIN}")

    assert os.path.exists(ENGINE_BIN), f"No se encontró el binario compilado en {ENGINE_BIN}"

    # Iniciar motor con argumento explícito --pipe
    proc = subprocess.Popen(
        [ENGINE_BIN, "--pipe", PIPE_NAME],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        bufsize=1,
    )

    received_events = []
    stop_event = threading.Event()

    def reader_thread():
        for line in proc.stdout:
            line = line.strip()
            if not line:
                continue
            try:
                parsed = json.loads(line)
                if parsed.get("type") == "transcription_ready":
                    now = time.perf_counter()
                    received_events.append((now, parsed))
            except Exception:
                pass
            if stop_event.is_set():
                break

    t = threading.Thread(target=reader_thread, daemon=True)
    t.start()

    # Pausa de 100ms para asegurar inicialización del pipe en el motor
    time.sleep(0.1)

    test_commands = [
        "abrir pestana",
        "guardar cambios",
        "configuracion de audio",
        "cancelar proceso"
    ]

    latencies = []

    for cmd in test_commands:
        t_start = time.perf_counter()
        success = send_named_pipe(PIPE_NAME, cmd)
        assert success, f"Error al escribir '{cmd}' en el Named Pipe"

        # Esperar recepción reactiva
        timeout = 1.0
        deadline = time.perf_counter() + timeout
        matched = False
        while time.perf_counter() < deadline:
            for t_rec, ev in received_events:
                if ev.get("transcript") == cmd:
                    latency_ms = (t_rec - t_start) * 1000.0
                    latencies.append(latency_ms)
                    print(f"  ⚡ Recibido reactivamente: '{cmd}' en {latency_ms:.3f} ms")
                    matched = True
                    break
            if matched:
                break
            time.sleep(0.001)

        assert matched, f"No se recibió a tiempo el evento para '{cmd}'"

    # Verificación de latencia
    avg_latency = sum(latencies) / len(latencies)
    max_latency = max(latencies)
    print(f"\n[MÉTRICAS] Latencia promedio: {avg_latency:.3f} ms, Máxima: {max_latency:.3f} ms")
    assert max_latency < 15.0, f"La latencia máxima ({max_latency:.3f} ms) excedió el límite de 15ms sin sleep"

    # Terminar proceso limpiamente cerrando stdin
    stop_event.set()
    proc.stdin.close()
    proc.wait(timeout=2.0)
    print("✅ [PASS] Prueba de Named Pipe Reactivo completada exitosamente.")

    # Verificación de fallback con --ipc
    print("\n=== [TEST FALLBACK] Verificación de fallback hacia atrás con --ipc <archivo> ===")
    ipc_file = os.path.join(tempfile.gettempdir(), f"zen_e2e_fallback_{os.getpid()}.ipc")
    fallback_proc = subprocess.Popen(
        [ENGINE_BIN, "--ipc", ipc_file],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        bufsize=1,
    )

    fallback_events = []
    fallback_stop = threading.Event()

    def fallback_reader():
        for line in fallback_proc.stdout:
            line = line.strip()
            if not line:
                continue
            try:
                parsed = json.loads(line)
                if parsed.get("type") == "transcription_ready":
                    fallback_events.append(parsed)
            except Exception:
                pass
            if fallback_stop.is_set():
                break

    t_fb = threading.Thread(target=fallback_reader, daemon=True)
    t_fb.start()
    time.sleep(0.1)

    with open(ipc_file, "a", encoding="utf-8") as f:
        f.write("comando por archivo fallback\n")

    deadline = time.perf_counter() + 1.0
    fb_matched = False
    while time.perf_counter() < deadline:
        if any(ev.get("transcript") == "comando por archivo fallback" for ev in fallback_events):
            fb_matched = True
            break
        time.sleep(0.01)

    assert fb_matched, "No se recibió el evento desde el archivo de fallback"
    print("  📁 Recibido correctamente comando desde archivo IPC de fallback.")

    fallback_stop.set()
    fallback_proc.stdin.close()
    fallback_proc.wait(timeout=2.0)
    try:
        os.remove(ipc_file)
    except Exception:
        pass
    print("✅ [PASS] Verificación de fallback hacia atrás completada exitosamente.")

if __name__ == "__main__":
    main()
