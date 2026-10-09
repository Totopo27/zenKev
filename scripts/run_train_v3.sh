#!/usr/bin/env bash
set -e

# Asegurar aislamiento en Disco D
export HF_HOME="/mnt/d/Zen/cache_hf"
export UV_CACHE_DIR="/mnt/d/Zen/cache_uv"
export CUDA_VISIBLE_DEVICES=0

DATA_DIR="/mnt/d/DocumentosDiscoD/Zen/zenKev/data/v3_consolidated"
TRAIN_DATA="$DATA_DIR/train.jsonl"
OUT_RUN="/mnt/d/Zen/runs/zenkev-v3"

echo "=========================================================="
echo "🚀 INICIANDO FINE-TUNING DE KEV-4B V3 EN RTX 3060 (12 GB)"
echo "Ruta de datos (Disco D): $TRAIN_DATA (2,297 muestras de train)"
echo "Salida del modelo (Disco D): $OUT_RUN"
echo "Caché de HuggingFace (Disco D): $HF_HOME"
echo "=========================================================="

cd /mnt/d/Zen/kev_repo

# Si por alguna interrupción previa quedó la carpeta creada, limpiarla para evitar el check de overwrite
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
echo "✅ ENTRENAMIENTO V3 COMPLETADO CON ÉXITO"
echo "=========================================================="
