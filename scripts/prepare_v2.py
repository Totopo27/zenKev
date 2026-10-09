import os
import json
import random

def merge_v2():
    v1_file = "data/zenkev_5k.jsonl"
    ollama_file = "data/zenkev_ollama_1k.jsonl"
    out_dir = "data/v2_consolidated"
    os.makedirs(out_dir, exist_ok=True)
    
    records = []
    seen = set()
    
    # 1. Cargar v1
    if os.path.exists(v1_file):
        with open(v1_file, "r", encoding="utf-8") as f:
            for line in f:
                if line.strip():
                    try:
                        d = json.loads(line)
                        k = d["state"].strip().lower()
                        if k not in seen:
                            seen.add(k)
                            records.append(d)
                    except Exception:
                        pass
                        
    # 2. Cargar ollama
    if os.path.exists(ollama_file):
        with open(ollama_file, "r", encoding="utf-8") as f:
            for line in f:
                if line.strip():
                    try:
                        d = json.loads(line)
                        k = d["state"].strip().lower()
                        if k not in seen:
                            seen.add(k)
                            records.append(d)
                    except Exception:
                        pass

    print(f"Total registros únicos consolidados para v2: {len(records)}")
    
    # Split 70% train, 15% calibration, 15% development
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
        
    print("[OK] Split de v2 completado con exito.")

if __name__ == "__main__":
    merge_v2()
