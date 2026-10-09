#!/usr/bin/env python3
import json
import time
import os
import torch
import numpy as np

os.environ["HF_HOME"] = "/mnt/d/Zen/cache_hf"
os.environ["UV_CACHE_DIR"] = "/mnt/d/Zen/cache_uv"
os.environ["CUDA_VISIBLE_DEVICES"] = "0"

from kev.checkpoint import Checkpoint, LoadOptions
from kev.data import materialize
from kev.device import default_device, empty_cache, sync

def evaluate():
    run_path = "/mnt/d/Zen/runs/zenkev-v4-final"
    dev_path = "/mnt/d/DocumentosDiscoD/Zen/zenKev/data/v4_final_5k/development.jsonl"
    
    print("==========================================================")
    print("🔬 EVALUANDO CHECKPOINT FINAL KEV-4B V4 EN RTX 3060")
    print(f"Ruta del modelo: {run_path}")
    print(f"Dataset de validación final: {dev_path}")
    print("==========================================================")

    t0 = time.time()
    tok, model = Checkpoint(run_path).load(device=torch.device("cuda"), opts=LoadOptions(dtype=torch.bfloat16))
    model.eval()
    print(f"[OK] Modelo y tokenizer cargados en CUDA ({time.time() - t0:.2f}s)\n")

    with open(dev_path, "r", encoding="utf-8") as f:
        records = [json.loads(line) for line in f if line.strip()]

    total_examples = len(records)
    print(f"Total de ejemplos a evaluar: {total_examples}")
    
    subsystem_correct = 0
    action_correct = 0
    latencies = []

    with torch.no_grad():
        for i, req in enumerate(records):
            for qid, q_data in req.get("questions", {}).items():
                if "src" not in q_data:
                    q_data["src"] = "zenkev"

            rec = materialize(req)
            t_start = time.perf_counter()
            
            enc = model.encode(tok, rec, strict=True)
            probs = model.probs(enc)
            
            sync("cuda")
            latencies.append((time.perf_counter() - t_start) * 1000.0)
            
            sub_pred_idx = int(probs[0].argmax())
            act_pred_idx = int(probs[1].argmax())
            
            sub_true_idx = rec["questions"][0]["label"]
            act_true_idx = rec["questions"][1]["label"]
            
            if sub_pred_idx == sub_true_idx:
                subsystem_correct += 1
            if act_pred_idx == act_true_idx:
                action_correct += 1

    sub_acc = (subsystem_correct / total_examples) * 100.0
    act_acc = (action_correct / total_examples) * 100.0
    mean_lat = np.mean(latencies)
    p95_lat = np.percentile(latencies, 95)

    print("\n==========================================================")
    print(f"📊 RESULTADOS DE EVALUACIÓN FINAL V4 ({total_examples} Held-out Development Set)")
    print("==========================================================")
    print(f"🎯 Precisión Subsistema (subsystem): {sub_acc:.2f}% ({subsystem_correct}/{total_examples})")
    print(f"🎯 Precisión Acción (action):         {act_acc:.2f}% ({action_correct}/{total_examples})")
    print(f"⚡ Latencia Media:                   {mean_lat:.2f} ms")
    print(f"⚡ Latencia P95:                     {p95_lat:.2f} ms")
    print("==========================================================")

    empty_cache("cuda")
    print("[OK] Memoria VRAM liberada con exito.")

if __name__ == "__main__":
    evaluate()
