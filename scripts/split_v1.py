import json
import random
import os

def split_dataset(input_file: str, output_dir: str, train_ratio=0.70, calib_ratio=0.15, test_ratio=0.15):
    os.makedirs(output_dir, exist_ok=True)
    records = []
    with open(input_file, 'r', encoding='utf-8') as f:
        for line in f:
            line = line.strip()
            if line:
                records.append(json.loads(line))

    # Semilla fija para reproducibilidad
    random.seed(42)
    random.shuffle(records)

    n_total = len(records)
    n_train = int(n_total * train_ratio)
    n_calib = int(n_total * calib_ratio)
    
    train_set = records[:n_train]
    calib_set = records[n_train:n_train + n_calib]
    test_set = records[n_train + n_calib:]

    files = {
        "train.jsonl": train_set,
        "calibration.jsonl": calib_set,
        "development.jsonl": test_set
    }

    print(f"=== SPLIT DEL DATASET PILOTO ({n_total} REGISTROS) ===")
    for fname, data in files.items():
        path = os.path.join(output_dir, fname)
        with open(path, 'w', encoding='utf-8') as f:
            for item in data:
                f.write(json.dumps(item, ensure_ascii=False) + '\n')
        pct = len(data) / n_total * 100
        print(f"  [+] {fname}: {len(data)} registros ({pct:.1f}%) guardado en {path}")

if __name__ == '__main__':
    split_dataset('data/zenkev_5k.jsonl', 'data/v1_1311')
