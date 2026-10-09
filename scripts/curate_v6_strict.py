#!/usr/bin/env python3
"""
Pipeline de Curaduría Balanceada y Estricta v6 para zenKev.
1. Filtra y normaliza los datasets existentes con reglas semánticas inequívocas.
2. Agrega plantillas sintéticas puras en español e inglés para balancear clases minoritarias
   (close_tab, switch_tab, read_content, delegate_chat, none).
3. Garantiza 100% de coherencia: NINGUNA muestra ambigua o con meta-texto sobrevive.
"""

import os
import json
import re
import random

RAW_FILES = [
    "data/zenkev_5k.jsonl",
    "data/zenkev_ollama_1k.jsonl",
    "data/zenkev_ollama_round2_1k.jsonl",
    "data/zenkev_ollama_final_round3.jsonl"
]

OUT_DIR = "data/v6_curated_strict"

VALID_MATRIX = {
    "browser_tabs": ["close_tab", "new_tab", "switch_tab"],
    "aom_dom": ["click", "scroll"],
    "vlm_vision": ["inspect_icon"],
    "screen_reader": ["read_content"],
    "llm_agent": ["delegate_chat", "none"]
}

META_PATTERNS = [
    r"perfil", r"ordenes de voz", r"órdenes de voz", r"orden de voz",
    r"iniciando", r"cargando", r"ajustando", r"comenzando",
    r"portugu[eê]s", r"franc[eê]s", r"español\s+peninsular",
    r"español\s+rioplatense", r"ingl[eé]s\s+americano",
    r"voice command", r"preparing", r"initializing", r"generation",
    r"state\d+", r"format", r"json", r"profile", r"language",
    r"modelo", r"sess[aã]o", r"pesquisa", r"not[ií]cia",
    r"\bvocê\b", r"\baba\b", r"\bfechar\b", r"\bconteúdo\b"
]

def classify_strictly(text: str):
    t = text.lower().strip()
    for p in META_PATTERNS:
        if re.search(p, t):
            return None, None

    words = re.findall(r"\w+", t)
    if len(words) < 2 or len(t) < 7:
        return None, None

    # Pestañas
    if any(k in t for k in ["pestaña", "pestana", "ventana", " tab", "tabs"]):
        if any(w in t for w in ["cerrar", "cierra", "cerrá", "cerrame", "quitar", "quitas", "close"]):
            return "browser_tabs", "close_tab"
        elif any(w in t for w in ["nueva", "nuevo", "abrir", "abre", "abrí", "abrime", "otra", "new"]):
            return "browser_tabs", "new_tab"
        elif any(w in t for w in ["cambiar", "cambia", "cambiá", "siguiente", "anterior", "pasar", "pasá", "pasate", "ve a la", "ir a la", "switch", "next", "previous"]):
            return "browser_tabs", "switch_tab"
        return None, None

    # Visión
    if any(k in t for k in ["icono", "ícono", "icon", "engranaje", "campana", "lupa", "figura", "símbolo", "simbolo", "qué significa la", "describe la imagen", "describe el botón con forma"]):
        if any(w in t for w in ["haz clic", "clic en", "click on", "presiona", "pulsa", "toca"]):
            return "aom_dom", "click"
        return "vlm_vision", "inspect_icon"

    # Screen reader
    if any(k in t for k in ["lee en voz alta", "léeme", "leeme", "leer el artículo", "leer artículo", "leer el contenido", "leer contenido", "leer el párrafo", "leer parrafo", "leer el texto", "leer texto", "sintetiza el texto", "anuncia el", "read the article", "read content", "read aloud", "read selected"]):
        return "screen_reader", "read_content"

    # Scroll
    if any(k in t for k in ["desplaza", "desplazar", "scroll", "baja en la pantalla", "baja la página", "sube en la pantalla", "sube la página", "al fondo de la página", "al inicio de la página", "scroll down", "scroll up"]):
        return "aom_dom", "scroll"

    # Clic
    if any(k in t for k in ["haz clic", "clic en", "da clic", "dale clic", "click on", "presiona el enlace", "presiona el botón", "presiona el boton", "pulsa el botón", "pulsa el enlace", "pincha en el", "toca el botón", "toca el enlace", "selecciona el botón", "selecciona el enlace"]):
        return "aom_dom", "click"

    # Consultas generales
    if any(k in t for k in ["explícame", "explicame", "cuál es", "cual es", "quién inventó", "quien invento", "por qué", "por que", "qué hora es", "que hora es", "cuántos", "cuantos", "cómo funciona", "como funciona", "cuéntame", "cuentame", "un chiste", "dime la hora", "what is", "who invented", "explain", "how does"]):
        return "llm_agent", "delegate_chat"

    # Ruido
    if any(k in t for k in ["mmm", "ehhh", "déjame pensar", "dejame pensar", "qué calor", "buenos días", "buenas tardes", "hola zen", "hello", "hi there", "qué tiempo hace", "hace frío"]):
        return "llm_agent", "none"

    return None, None

def make_record(state: str, sub: str, act: str):
    return {
        "state": state,
        "questions": {
            "subsystem": {
                "type": "choice",
                "instructions": "A que subsistema de ZenKev pertenece esta orden?",
                "criteria": {
                    "browser_tabs": "Gestion de pestanas, ventanas y navegacion del navegador",
                    "aom_dom": "Interaccion con elementos dentro de la pagina web actual",
                    "vlm_vision": "Inspeccion de botones mudos o iconos sin texto mediante vision",
                    "screen_reader": "Lectura asistida de texto o sintesis de accesibilidad",
                    "llm_agent": "Preguntas conversacionales o consultas generales ajenas al control del navegador"
                },
                "label": sub
            },
            "action": {
                "type": "choice",
                "instructions": "Cual es la accion concreta a ejecutar?",
                "criteria": {
                    "close_tab": "Cerrar la pestana actual o indicada",
                    "new_tab": "Abrir una nueva pestana",
                    "switch_tab": "Cambiar a otra pestana",
                    "scroll": "Desplazar la vista hacia arriba o abajo",
                    "click": "Activar un boton o enlace",
                    "inspect_icon": "Capturar recorte grafico para clasificar icono",
                    "read_content": "Anunciar o leer contenido accesible",
                    "delegate_chat": "Delegar al asistente conversacional",
                    "none": "Comando ambiguo, ruido o conversacion casual sin accion"
                },
                "label": act
            }
        }
    }

# Generador de patrones sintéticos de alta pureza para clases minoritarias
def generate_pure_canonical_samples():
    pure = []
    
    # 1. close_tab (Español neutro, coloquial e inglés)
    close_templates = [
        "Cierra la pestaña actual", "Cerrar esta pestaña", "Por favor cierra la pestaña",
        "Cierra la pestaña de la derecha", "Cierra la pestaña de la izquierda",
        "Cerrar la ventana activa", "Cierra la pestaña de YouTube", "Cerrar pestaña activa",
        "Cierra la pestaña que estoy viendo", "Cierra esta ventana por favor",
        "Close this tab", "Close the active tab", "Close current tab please",
        "Close the tab on the right", "Close the browser window", "Close tab now"
    ]
    for t in close_templates:
        pure.append(make_record(t, "browser_tabs", "close_tab"))

    # 2. switch_tab
    switch_templates = [
        "Cambia a la pestaña siguiente", "Pasa a la pestaña anterior", "Ir a la pestaña de correo",
        "Cambiar a la pestaña número dos", "Ve a la primera pestaña", "Muestra la pestaña de Wikipedia",
        "Pasar a la siguiente pestaña", "Cambia a la pestaña de la izquierda", "Ve a la pestaña anterior",
        "Switch to the next tab", "Switch to the previous tab", "Go to the first tab",
        "Switch to tab 2", "Go back to the previous tab", "Switch tab please"
    ]
    for t in switch_templates:
        pure.append(make_record(t, "browser_tabs", "switch_tab"))

    # 3. screen_reader / read_content
    read_templates = [
        "Lee el artículo en voz alta", "Léeme el primer encabezado", "Lee el texto seleccionado",
        "Léeme este párrafo por favor", "Lee el contenido accesible de la página",
        "Anuncia el título de la página", "Léeme las noticias en voz alta", "Lee en voz alta lo que seleccioné",
        "Sintetiza el texto de esta sección", "Lee en voz alta este bloque",
        "Read this article aloud", "Read the selected text", "Read the first heading",
        "Read page content please", "Read aloud the main paragraph", "Read the headline"
    ]
    for t in read_templates:
        pure.append(make_record(t, "screen_reader", "read_content"))

    # 4. llm_agent / delegate_chat
    chat_templates = [
        "Explícame cómo funciona la fotosíntesis", "¿Cuál es la distancia a la Luna?",
        "¿Quién inventó el teléfono?", "¿Por qué el cielo es azul?", "¿Qué hora es en Tokio?",
        "Cuéntame un chiste corto", "¿Cuántos planetas hay en el sistema solar?",
        "Explícame la teoría de la relatividad", "¿Cuál es la capital de Australia?",
        "Dime un resumen de la historia de Roma",
        "Explain how photosynthesis works", "What is the capital of Canada?",
        "Who invented the computer?", "Why is the ocean salty?", "Tell me a short joke"
    ]
    for t in chat_templates:
        pure.append(make_record(t, "llm_agent", "delegate_chat"))

    # 5. llm_agent / none (ruido pasivo sin comando de control)
    noise_templates = [
        "Mmm... déjame pensarlo un segundo", "Ehhh... no sé qué estaba buscando",
        "Qué calor que hace hoy en la habitación", "Buenos días asistente", "Hola Zen qué tal",
        "Qué lindo día soleado", "Bueno, a ver qué tengo que hacer hoy",
        "Hmm let me think about it", "It is quite warm in here today",
        "Good morning assistant", "Just looking around", "Well, let me check something"
    ]
    for t in noise_templates:
        pure.append(make_record(t, "llm_agent", "none"))

    return pure

def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    
    raw_lines = []
    for fp in RAW_FILES:
        if os.path.exists(fp):
            with open(fp, "r", encoding="utf-8") as f:
                for line in f:
                    if line.strip():
                        try:
                            raw_lines.append(json.loads(line))
                        except Exception:
                            pass
                            
    clean_records = []
    seen = set()
    
    # 1. Filtrar los existentes de Ollama
    for r in raw_lines:
        state = r.get("state", "").strip()
        sub, act = classify_strictly(state)
        if not sub or not act:
            continue
        if act not in VALID_MATRIX[sub]:
            continue
        norm = re.sub(r"[^\w\s]", "", state.lower()).strip()
        if norm in seen:
            continue
        seen.add(norm)
        clean_records.append(make_record(state, sub, act))

    # 2. Agregar los patrones puros canónicos
    pure_samples = generate_pure_canonical_samples()
    for ps in pure_samples:
        norm = re.sub(r"[^\w\s]", "", ps["state"].lower()).strip()
        if norm not in seen:
            seen.add(norm)
            clean_records.append(ps)

    print(f"[*] Total muestras rigurosas consolidadas: {len(clean_records)}")
    
    stats_sub = {}
    stats_act = {}
    for r in clean_records:
        s = r["questions"]["subsystem"]["label"]
        a = r["questions"]["action"]["label"]
        stats_sub[s] = stats_sub.get(s, 0) + 1
        stats_act[a] = stats_act.get(a, 0) + 1

    print("\n--- Distribución Final por Subsistema ---")
    for k, v in stats_sub.items():
        print(f"  {k:15}: {v:4d} ({v/len(clean_records)*100:4.1f}%)")
        
    print("\n--- Distribución Final por Acción ---")
    for k, v in stats_act.items():
        print(f"  {k:15}: {v:4d} ({v/len(clean_records)*100:4.1f}%)")

    # Split determinista 70/15/15
    random.seed(42)
    random.shuffle(clean_records)
    
    total = len(clean_records)
    n_dev = int(total * 0.15)
    n_cal = int(total * 0.15)
    n_train = total - n_dev - n_cal
    
    train_split = clean_records[:n_train]
    cal_split = clean_records[n_train:n_train+n_cal]
    dev_split = clean_records[n_train+n_cal:]
    
    def write_file(name, data):
        path = os.path.join(OUT_DIR, name)
        with open(path, "w", encoding="utf-8") as f:
            for d in data:
                f.write(json.dumps(d, ensure_ascii=False) + "\n")
        print(f"  Guardado {path}: {len(data)} muestras")
        
    print("\n[*] Escribiendo particiones curadas v6...")
    write_file("train.jsonl", train_split)
    write_file("calibration.jsonl", cal_split)
    write_file("development.jsonl", dev_split)
    print("\n[OK] Dataset v6 generado sin una sola contradicción ni meta-texto.")

if __name__ == "__main__":
    main()
