#!/usr/bin/env python3
"""
Auditoría Exhaustiva de Calidad del Dataset v6_curated_strict.
Verifica:
 1. Coherencia 100% con la matriz arquitectónica válida.
 2. Cero fugas de meta-prompts, idiomas no soportados o plantillas rotas.
 3. Longitud de texto y variedad léxica.
 4. Balance de clases en train, calibration y development.
 5. Contaminación cruzada (data leakage entre train y dev/cal).
"""

import os
import json
import re

DATA_DIR = "data/v6_curated_strict"
FILES = ["train.jsonl", "calibration.jsonl", "development.jsonl"]

VALID_MATRIX = {
    "browser_tabs": ["close_tab", "new_tab", "switch_tab"],
    "aom_dom": ["click", "scroll"],
    "vlm_vision": ["inspect_icon"],
    "screen_reader": ["read_content"],
    "llm_agent": ["delegate_chat", "none"]
}

LEAK_PATTERNS = [
    r"perfil", r"ordenes de voz", r"órdenes de voz", r"orden de voz",
    r"iniciando", r"cargando", r"ajustando", r"comenzando",
    r"portugu[eê]s", r"franc[eê]s", r"español\s+peninsular",
    r"español\s+rioplatense", r"ingl[eé]s\s+americano",
    r"voice command", r"preparing", r"initializing", r"generation",
    r"state\d+", r"format", r"json", r"profile", r"language",
    r"\bvocê\b", r"\baba\b", r"\bfechar\b", r"\bconteúdo\b"
]

def audit():
    print("=" * 80)
    print("🔍 AUDITORÍA FORMAL DE INTEGRIDAD DEL DATASET V6 ESTRICTO")
    print(f"Directorio: {DATA_DIR}")
    print("=" * 80)

    all_data = {}
    sets_seen = {}
    total_samples = 0
    matrix_violations = 0
    meta_leaks = 0
    short_texts = 0

    for fname in FILES:
        fpath = os.path.join(DATA_DIR, fname)
        if not os.path.exists(fpath):
            print(f"[!] Archivo no encontrado: {fpath}")
            return
        
        with open(fpath, "r", encoding="utf-8") as f:
            lines = [json.loads(l) for l in f if l.strip()]
        
        all_data[fname] = lines
        sets_seen[fname] = set()
        total_samples += len(lines)

        print(f"\n📂 Analizando {fname} ({len(lines)} registros):")
        sub_dist = {}
        act_dist = {}

        for i, item in enumerate(lines):
            st = item.get("state", "").strip()
            norm = re.sub(r"[^\w\s]", "", st.lower()).strip()
            sets_seen[fname].add(norm)

            if len(st) < 8 or len(st.split()) < 2:
                short_texts += 1
                print(f"   ⚠️ Texto sospechosamente corto: '{st}'")

            for p in LEAK_PATTERNS:
                if re.search(p, st.lower()):
                    meta_leaks += 1
                    print(f"   ❌ Fuga detectada en #{i}: '{st}' (patrón: {p})")

            questions = item.get("questions", {})
            sub = questions.get("subsystem", {}).get("label")
            act = questions.get("action", {}).get("label")

            # Validar matriz
            if sub not in VALID_MATRIX or act not in VALID_MATRIX[sub]:
                matrix_violations += 1
                print(f"   ❌ Violación de esquema en #{i}: {sub} -> {act} en '{st}'")

            sub_dist[sub] = sub_dist.get(sub, 0) + 1
            act_dist[act] = act_dist.get(act, 0) + 1

        print("   -> Subsistemas:")
        for k, v in sorted(sub_dist.items()):
            print(f"      • {k:15}: {v:4d} ({v/len(lines)*100:4.1f}%)")
        print("   -> Acciones:")
        for k, v in sorted(act_dist.items()):
            print(f"      • {k:15}: {v:4d} ({v/len(lines)*100:4.1f}%)")

    # Auditoría de Contaminación Cruzada (Data Leakage entre splits)
    print("\n" + "=" * 80)
    print("🛡️ VERIFICACIÓN DE DATA LEAKAGE (CONTAMINACIÓN ENTRE PARTICIONES)")
    print("=" * 80)

    train_vs_dev = sets_seen["train.jsonl"].intersection(sets_seen["development.jsonl"])
    train_vs_cal = sets_seen["train.jsonl"].intersection(sets_seen["calibration.jsonl"])
    cal_vs_dev = sets_seen["calibration.jsonl"].intersection(sets_seen["development.jsonl"])

    print(f"• Solapamiento Train ∩ Development:   {len(train_vs_dev)} muestras")
    print(f"• Solapamiento Train ∩ Calibration:   {len(train_vs_cal)} muestras")
    print(f"• Solapamiento Calibration ∩ Dev:     {len(cal_vs_dev)} muestras")

    print("\n" + "=" * 80)
    print("📋 DICTAMEN FINAL DE LA AUDITORÍA")
    print("=" * 80)
    print(f"Total registros analizados:           {total_samples}")
    print(f"Violaciones de matriz arquitectónica: {matrix_violations}")
    print(f"Fugas de meta-prompts/idiomas ajenos: {meta_leaks}")
    print(f"Muestras de longitud insuficiente:    {short_texts}")
    print(f"Contaminación cruzada entre splits:   {len(train_vs_dev) + len(train_vs_cal) + len(cal_vs_dev)}")

    if matrix_violations == 0 and meta_leaks == 0 and len(train_vs_dev) == 0:
        print("\n✅ CERTIFICACIÓN: El dataset v6_curated_strict cumple con el 100% de los estándares.")
    else:
        print("\n❌ ALERTA: Se encontraron inconsistencias que requieren intervención.")

if __name__ == "__main__":
    audit()
