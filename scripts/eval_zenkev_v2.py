#!/usr/bin/env python3
import json
import time
import os
import torch
import numpy as np

# Configurar caches en Disco D
os.environ["HF_HOME"] = "/mnt/d/Zen/cache_hf"
os.environ["UV_CACHE_DIR"] = "/mnt/d/Zen/cache_uv"
os.environ["CUDA_VISIBLE_DEVICES"] = "0"

from kev.checkpoint import Checkpoint, LoadOptions
from kev.data import materialize
from kev.device import default_device, empty_cache, sync

def evaluate():
    run_path = "/mnt/d/Zen/runs/zenkev-v2"
    dev_path = "/mnt/d/DocumentosDiscoD/Zen/zenKev/data/v2_consolidated/development.jsonl"
    
    print("==========================================================")
    print("🔬 EVALUANDO CHECKPOINT KEV-4B V2 EN RTX 3060")
    print(f"Ruta del modelo: {run_path}")
    print(f"Dataset de validación: {dev_path}")
    print("==========================================================")

    # Cargar checkpoint
    t0 = time.time()
    tok, model = Checkpoint(run_path).load(device=torch.device("cuda"), opts=LoadOptions(dtype=torch.bfloat16))
    model.eval()
    print(f"[OK] Modelo y tokenizer cargados en CUDA ({time.time() - t0:.2f}s)\n")

    # Leer dataset de desarrollo
    with open(dev_path, "r", encoding="utf-8") as f:
        records = [json.loads(line) for line in f if line.strip()]

    print(f"Total de ejemplos a evaluar: {len(records)}")
    
    subsystem_correct = 0
    action_correct = 0
    total_examples = len(records)
    latencies = []
    
    confusion_samples = []

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
            latencies.append((time.perf_counter() - t_start) * 1000.0) # ms
            
            sub_pred_idx = int(probs[0].argmax())
            act_pred_idx = int(probs[1].argmax())
            
            sub_true_idx = rec["questions"][0]["label"]
            act_true_idx = rec["questions"][1]["label"]
            
            sub_ok = (sub_pred_idx == sub_true_idx)
            act_ok = (act_pred_idx == act_true_idx)
            
            if sub_ok:
                subsystem_correct += 1
            if act_ok:
                action_correct += 1
                
            if not (sub_ok and act_ok) and len(confusion_samples) < 5:
                sub_opts = list(req["questions"]["subsystem"]["criteria"].keys())
                act_opts = list(req["questions"]["action"]["criteria"].keys())
                confusion_samples.append({
                    "state": req["state"],
                    "expected_sub": req["questions"]["subsystem"]["label"],
                    "pred_sub": sub_opts[sub_pred_idx] if sub_pred_idx < len(sub_opts) else str(sub_pred_idx),
                    "expected_act": req["questions"]["action"]["label"],
                    "pred_act": act_opts[act_pred_idx] if act_pred_idx < len(act_opts) else str(act_pred_idx),
                })

    sub_acc = (subsystem_correct / total_examples) * 100.0
    act_acc = (action_correct / total_examples) * 100.0
    mean_lat = np.mean(latencies)
    p95_lat = np.percentile(latencies, 95)

    print("\n==========================================================")
    print("📊 RESULTADOS DE EVALUACIÓN V2 (346 Held-out Development Set)")
    print("==========================================================")
    print(f"🎯 Precisión Subsistema (subsystem): {sub_acc:.2f}% ({subsystem_correct}/{total_examples})")
    print(f"🎯 Precisión Acción (action):         {act_acc:.2f}% ({action_correct}/{total_examples})")
    print(f"⚡ Latencia Media:                   {mean_lat:.2f} ms")
    print(f"⚡ Latencia P95:                     {p95_lat:.2f} ms")
    print("==========================================================")

    if confusion_samples:
        print("\n🔍 MUESTRA DE DISCREPANCIAS RESTANTES:")
        for s in confusion_samples:
            print(f"- Frase: \"{s['state']}\"")
            print(f"  Esperado: sub={s['expected_sub']}, act={s['expected_act']}")
            print(f"  Predicho: sub={s['pred_sub']}, act={s['pred_act']}\n")

    empty_cache("cuda")
    print("[OK] Memoria VRAM liberada con exito.")

if __name__ == "__main__":
    evaluate()
