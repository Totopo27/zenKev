import os
import subprocess
import sys

def main():
    print("=== SUPERVISOR V4 FINAL INICIADO ===", flush=True)
    cmd = ["bash", "/mnt/d/DocumentosDiscoD/Zen/zenKev/scripts/run_train_v4_final.sh"]
    print(f"Ejecutando: {' '.join(cmd)}", flush=True)
    res = subprocess.run(cmd)
    print(f"Finalizado con codigo: {res.returncode}", flush=True)

if __name__ == "__main__":
    main()
