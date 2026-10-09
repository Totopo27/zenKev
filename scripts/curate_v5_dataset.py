#!/usr/bin/env python3
"""
Pipeline de Curaduría y Auditoría de Datos para zenKev (Dataset v5 Curado).
Aplica reglas deterministas estrictas sobre los datasets crudos generados por Ollama:
 1. Descarte de meta-prompts, artefactos sintéticos y ruido de plantilla.
 2. Corrección automática de etiquetas con conflicto semántico evidente (ej: enlaces/botones DOM etiquetados como pestañas).
 3. Normalización lingüística y eliminación de redundancias/muestras de baja calidad.
 4. Partición estratificada limpia en train (70%), calibration (15%), development (15%).
"""

import os
import json
import random
import re

RAW_FILES = [
    "data/zenkev_5k.jsonl",
    "data/zenkev_ollama_1k.jsonl",
    "data/zenkev_ollama_round2_1k.jsonl",
    "data/zenkev_ollama_final_round3.jsonl"
]

OUT_DIR = "data/v5_curated"

# Meta-prompts o fugas del LLM que deben descartarse inmediatamente
NOISE_PATTERNS = [
    r"^iniciando\s+orden",
    r"^iniciando\s+sesion",
    r"^comenzando\s+orden",
    r"^perfil\s+de\s+español",
    r"^voice\s+command",
    r"^preparing_",
    r"^initializing",
    r"^generation",
    r"^state\d+",
    r"^open$",
    r"^close$",
    r"^tab$",
    r"^click$",
    r"^activada$",
    r"lenguaje\s+inglés",
    r"perfil\s+de\s+'español",
    r"próxima\s+orden:",
    r"formato\s+json",
    r"modelo\s+de\s+lenguaje"
]

DOM_CLICK_CLUES = [
    "enlace", "link", "botón", "boton", "clic en", "haz clic en", "click on",
    "presiona el", "pulsa el", "pincha en", "dale clic", "toca en", "selecciona el botón"
]

TAB_CLUES = [
    "pestaña", "pestana", "ventana", "tab", "tabs", "nueva pestaña", "cerrar pestaña"
]

VISION_CLUES = [
    "icono", "ícono", "icon", "engranaje", "campana", "lupa", "figura", "imagen",
    "qué significa el", "describe el botón con forma", "qué hace este símbolo"
]

READ_CLUES = [
    "lee en voz alta", "léeme", "leeme", "leer el contenido", "leer el artículo",
    "leer texto", "sintetiza el texto", "anuncia el", "read the article", "read content"
]

SCROLL_CLUES = [
    "desplaza", "scroll", "baja en la pantalla", "sube en la pantalla", "al fondo de la página",
    "al inicio de la página", "bajar la página", "subir la página", "scroll down", "scroll up"
]

def clean_and_curate():
    os.makedirs(OUT_DIR, exist_ok=True)
    raw_records = []
    
    # 1. Carga bruta
    for src in RAW_FILES:
        if os.path.exists(src):
            with open(src, "r", encoding="utf-8") as f:
                for line in f:
                    if line.strip():
                        try:
                            raw_records.append(json.loads(line))
                        except Exception:
                            pass

    print(f"[*] Total de registros leídos en bruto: {len(raw_records)}")

    curated = []
    seen = set()
    discarded_noise = 0
    repaired_labels = 0

    for r in raw_records:
        st = r.get("state", "").strip()
        if not st or len(st) < 4:
            discarded_noise += 1
            continue

        st_lower = st.lower()

        # Filtro 1: Descarte de ruido sintético
        if any(re.search(pat, st_lower) for pat in NOISE_PATTERNS):
            discarded_noise += 1
            continue

        # Normalización de deduplicación
        norm_key = re.sub(r"[^\w\s]", "", st_lower).strip()
        if norm_key in seen:
            continue
        seen.add(norm_key)

        questions = r.get("questions", {})
        subsystem = questions.get("subsystem", {}).get("label")
        action = questions.get("action", {}).get("label")

        orig_sub = subsystem
        orig_act = action

        # Filtro 2: Corrección determinista de reglas semánticas
        
        # Regla A: Si habla de iconos mudos o figuras sin texto -> vlm_vision
        if any(vc in st_lower for vc in VISION_CLUES) and not any(rc in st_lower for rc in READ_CLUES):
            if "clic" not in st_lower and "click" not in st_lower and "presiona" not in st_lower:
                subsystem = "vlm_vision"
                action = "inspect_icon"

        # Regla B: Clics explícitos en elementos interactivos (enlaces, botones web) -> aom_dom / click
        if any(dc in st_lower for dc in DOM_CLICK_CLUES):
            # A menos que sea cerrar o abrir pestaña explícitamente
            if not ("pestaña" in st_lower and ("cerrar" in st_lower or "abrir" in st_lower or "nueva" in st_lower)):
                subsystem = "aom_dom"
                action = "click"

        # Regla C: Lectura asistida de texto accesible -> screen_reader / read_content
        if any(rc in st_lower for rc in READ_CLUES):
            subsystem = "screen_reader"
            action = "read_content"

        # Regla D: Desplazamiento de página -> aom_dom / scroll
        if any(sc in st_lower for sc in SCROLL_CLUES):
            subsystem = "aom_dom"
            action = "scroll"

        # Regla E: Pestañas canónicas
        if ("pestaña" in st_lower or "pestana" in st_lower or "tab" in st_lower) and subsystem != "aom_dom" and subsystem != "vlm_vision":
            if any(w in st_lower for w in ["cerrar", "cierra", "close"]):
                subsystem = "browser_tabs"
                action = "close_tab"
            elif any(w in st_lower for w in ["abrir", "abre", "nueva", "new"]):
                subsystem = "browser_tabs"
                action = "new_tab"
            elif any(w in st_lower for w in ["cambiar", "cambia", "siguiente", "anterior", "ve a la", "switch"]):
                subsystem = "browser_tabs"
                action = "switch_tab"

        if (subsystem != orig_sub) or (action != orig_act):
            repaired_labels += 1

        # Reconstruir registro limpio
        r["questions"]["subsystem"]["label"] = subsystem
        r["questions"]["action"]["label"] = action
        curated.append(r)

    print(f"[*] Registros descartados por ruido o meta-prompts: {discarded_noise}")
    print(f"[*] Etiquetas reparadas y consistenciadas: {repaired_labels}")
    print(f"[*] Dataset curado final de alta calidad: {len(curated)} muestras únicas")

    # Partición estratificada reproducible
    random.seed(42)
    random.shuffle(curated)

    total = len(curated)
    n_dev = int(total * 0.15)
    n_cal = int(total * 0.15)
    n_train = total - n_dev - n_cal

    train_data = curated[:n_train]
    cal_data = curated[n_train:n_train + n_cal]
    dev_data = curated[n_train + n_cal:]

    print(f"[*] Distribución:")
    print(f"    - Train (70%):       {len(train_data)}")
    print(f"    - Calibration (15%): {len(cal_data)}")
    print(f"    - Development (15%): {len(dev_data)}")

    def write_jsonl(path, rows):
        with open(path, "w", encoding="utf-8") as f:
            for item in rows:
                f.write(json.dumps(item, ensure_ascii=False) + "\n")

    write_jsonl(os.path.join(OUT_DIR, "train.jsonl"), train_data)
    write_jsonl(os.path.join(OUT_DIR, "calibration.jsonl"), cal_data)
    write_jsonl(os.path.join(OUT_DIR, "development.jsonl"), dev_data)
    print(f"[OK] Archivos guardados exitosamente en {OUT_DIR}/")

if __name__ == "__main__":
    clean_and_curate()
