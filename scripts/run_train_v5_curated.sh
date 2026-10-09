#!/usr/bin/env bash
set -e

# Aislamiento en Disco D
export HF_HOME="/mnt/d/Zen/cache_hf"
export UV_CACHE_DIR="/mnt/d/Zen/cache_uv"
export CUDA_VISIBLE_DEVICES=0

DATA_DIR="/mnt/d/DocumentosDiscoD/Zen/zenKev/data/v5_curated"
TRAIN_DATA="$DATA_DIR/train.jsonl"
OUT_RUN="/mnt/d/Zen/runs/zenkev-v5-curated"

echo "=========================================================="
echo "🚀 INICIANDO FINE-TUNING DE KEV-4B V5 CURADO EN RTX 3060 (12 GB)"
echo "Ruta de datos curados: $TRAIN_DATA (3,424 muestras de train limpias)"
echo "Salida del modelo: $OUT_RUN"
echo "Caché de HuggingFace: $HF_HOME"
echo "=========================================================="

cd /mnt/d/Zen/kev_repo

rm -rf "$OUT_RUN"

/mnt/d/Zen/cache_uv/bin/uv run python -u -m kev.train \
  --data "$TRAIN_DATA" \
  --base "Qwen/Qwen3.5-4B-Base" \
  --init_from "jaredpalmer/kev-4b" \
  --epochs 2 \
  --lr 2e-5 \
  --batch 1 \
  --accum 8 \
  --dtype bf16 \
  --weights_dtype bf16 \
  --checkpointing 1 \
  --device cuda \
  --out "$OUT_RUN"

echo "=========================================================="
echo "✅ ENTRENAMIENTO V5 CURADO COMPLETADO CON ÉXITO"
echo "=========================================================="
