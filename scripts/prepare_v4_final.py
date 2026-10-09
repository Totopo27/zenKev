import os
import json
import random

def merge_v4():
    v1_file = "data/zenkev_5k.jsonl"
    r1_file = "data/zenkev_ollama_1k.jsonl"
    r2_file = "data/zenkev_ollama_round2_1k.jsonl"
    r3_file = "data/zenkev_ollama_final_round3.jsonl"
    out_dir = "data/v4_final_5k"
    os.makedirs(out_dir, exist_ok=True)
    
    records = []
    seen = set()
    
    for src in [v1_file, r1_file, r2_file, r3_file]:
        if os.path.exists(src):
            with open(src, "r", encoding="utf-8") as f:
                for line in f:
                    if line.strip():
                        try:
                            d = json.loads(line)
                            k = d["state"].strip().lower()
                            if any(bad in k for bad in ["voice command", "generation", "initializing", "preparing_"]):
                                continue
                            if k not in seen:
                                seen.add(k)
                                records.append(d)
                        except Exception:
                            pass

    print(f"Total registros unicos de alta fidelidad para el dataset FINAL: {len(records)}")
    
    random.seed(42)
    random.shuffle(records)
    
    n = len(records)
    n_dev = int(n * 0.15)
    n_cal = int(n * 0.15)
    n_train = n - n_dev - n_cal
    
    train_set = records[:n_train]
    cal_set = records[n_train:n_train + n_cal]
    dev_set = records[n_train + n_cal:]
    
    for name, data in [("train.jsonl", train_set), ("calibration.jsonl", cal_set), ("development.jsonl", dev_set)]:
        p = os.path.join(out_dir, name)
        with open(p, "w", encoding="utf-8") as f:
            for r in data:
                f.write(json.dumps(r, ensure_ascii=False) + "\n")
        print(f"  -> Guardado {p} ({len(data)} registros)")
        
    print("[OK] Split final 5k completado con exito.")

if __name__ == "__main__":
    merge_v4()
