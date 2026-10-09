import time
import subprocess
import os
import sys

def run():
    print("=== PIPELINE AUTOMATIZADO SECUENCIAL ===", flush=True)
    print("Fase 1: Ejecutando fine-tuning de Kev-4B v1 en GPU (weights_dtype=bf16)...", flush=True)
    
    cmd = ["wsl", "-d", "Ubuntu", "-e", "bash", "/mnt/d/DocumentosDiscoD/Zen/zenKev/scripts/run_train_v1.sh"]
    ret = subprocess.run(cmd)
    
    if ret.returncode != 0:
        print(f"\n[ERROR] El entrenamiento finalizó con código {ret.returncode}", flush=True)
        return

    print("\n[OK] ¡Entrenamiento completado y VRAM liberada!", flush=True)
    print("Fase 2: Iniciando generación de 1,000 registros con Ollama...", flush=True)
    
    subprocess.run(["python", "scripts/run_ollama_pipeline.py"])
    print("\n=== PIPELINE SECUENCIAL FINALIZADO CON EXITO ===", flush=True)

if __name__ == "__main__":
    run()
