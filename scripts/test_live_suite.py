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

WORKLOAD_CRITERIA = {
    "subsystems": {
        "browser_tabs": "Gestion de pestanas, ventanas y navegacion del navegador",
        "aom_dom": "Interaccion con elementos dentro de la pagina web actual",
        "vlm_vision": "Inspeccion de botones mudos o iconos sin texto mediante vision",
        "screen_reader": "Lectura asistida de texto o sintesis de accesibilidad",
        "llm_agent": "Preguntas conversacionales o consultas generales ajenas al control del navegador"
    },
    "actions": {
        "close_tab": "Cerrar la pestana actual o indicada",
        "new_tab": "Abrir una nueva pestana",
        "switch_tab": "Cambiar a otra pestana",
        "scroll": "Desplazar la vista hacia arriba o abajo",
        "click": "Activar un boton o enlace",
        "inspect_icon": "Capturar recorte grafico para clasificar icono",
        "read_content": "Anunciar o leer contenido accesible",
        "delegate_chat": "Delegar al asistente conversacional",
        "none": "Comando ambiguo, ruido o conversacion casual sin accion"
    }
}

TEST_PHRASES = [
    # 1. Pestañas / Ventanas (Rioplatense, neutro, coloquial)
    ("Che, cerrame la pestaña de Mercado Libre", "browser_tabs", "close_tab"),
    ("Pasate a la pestaña de YouTube que dejé pausada", "browser_tabs", "switch_tab"),
    ("Abrite una pestaña nueva, dale", "browser_tabs", "new_tab"),
    ("Cerrá todo y andate a la primera pestaña", "browser_tabs", "switch_tab"),
    
    # 2. Navegación en la página (DOM / Scroll / Clic)
    ("Bajá un toque la página que no llego a leer", "aom_dom", "scroll"),
    ("Hacé scroll hasta el fondo de la pantalla", "aom_dom", "scroll"),
    ("Dale clic al botón azul que dice Continuar", "aom_dom", "click"),
    ("Tocá en el enlace de inicio de sesión", "aom_dom", "click"),
    
    # 3. Visión / Iconos mudos (VLM)
    ("¿Qué corno hace ese icono de la campana?", "vlm_vision", "inspect_icon"),
    ("Describime el botón con forma de engranaje", "vlm_vision", "inspect_icon"),
    ("Explicame qué significa la estrella de arriba a la derecha", "vlm_vision", "inspect_icon"),
    
    # 4. Accesibilidad / Lectura (Screen Reader)
    ("Leeme el titular principal de esta noticia", "screen_reader", "read_content"),
    ("Leé en voz alta este párrafo seleccionado", "screen_reader", "read_content"),
    ("Dame un resumen hablado del texto de la página", "screen_reader", "read_content"),
    
    # 5. Agente Conversacional / Consultas Generales (LLM Agent)
    ("¿Quién inventó el transistor y en qué año?", "llm_agent", "delegate_chat"),
    ("Explicame la teoría de la relatividad para un nene de cinco años", "llm_agent", "delegate_chat"),
    ("Hola Zen, ¿cómo andás hoy?", "llm_agent", "delegate_chat"),
    
    # 6. Casos trampa / Ruido / Sin acción
    ("Ehhh... a ver qué onda esto", "llm_agent", "none"),
    ("Pfff, qué calor que hace acá adentro", "llm_agent", "none"),
    
    # 7. Inglés (Multilingüe de producción)
    ("Close this tab right now", "browser_tabs", "close_tab"),
    ("Scroll down to the footer", "aom_dom", "scroll"),
    ("What does the magnifying glass icon do?", "vlm_vision", "inspect_icon"),
]

def format_request(phrase: str) -> dict:
    return {
        "state": phrase,
        "questions": {
            "subsystem": {
                "type": "choice",
                "instructions": "A que subsistema de ZenKev pertenece esta orden?",
                "criteria": WORKLOAD_CRITERIA["subsystems"],
                "label": "browser_tabs", # dummy para materialize
                "src": "zenkev"
            },
            "action": {
                "type": "choice",
                "instructions": "Cual es la accion concreta a ejecutar?",
                "criteria": WORKLOAD_CRITERIA["actions"],
                "label": "close_tab", # dummy para materialize
                "src": "zenkev"
            }
        }
    }

def run_tests():
    run_path = "/mnt/d/Zen/runs/zenkev-v2"
    print("==========================================================================================")
    print("🤖 BATERÍA DE PRUEBAS AUTOMATIZADAS — KEV-4B V2 EN VIVO (RTX 3060)")
    print("==========================================================================================")
    
    t0 = time.time()
    tok, model = Checkpoint(run_path).load(device=torch.device("cuda"), opts=LoadOptions(dtype=torch.bfloat16))
    model.eval()
    print(f"[OK] Modelo cargado en VRAM en {time.time() - t0:.2f}s\n")
    
    sub_keys = list(WORKLOAD_CRITERIA["subsystems"].keys())
    act_keys = list(WORKLOAD_CRITERIA["actions"].keys())
    
    print(f"{'Comando de Voz':<50} | {'Subsistema':<14} | {'Acción':<14} | {'Conf':<6} | {'Latencia':<8}")
    print("-" * 105)
    
    total = len(TEST_PHRASES)
    hits_sub = 0
    hits_act = 0
    latencies = []
    
    with torch.no_grad():
        for phrase, expected_sub, expected_act in TEST_PHRASES:
            req = format_request(phrase)
            rec = materialize(req)
            
            t_start = time.perf_counter()
            enc = model.encode(tok, rec, strict=True)
            probs = model.probs(enc)
            sync("cuda")
            lat = (time.perf_counter() - t_start) * 1000.0
            latencies.append(lat)
            
            p_sub = probs[0].numpy()
            p_act = probs[1].numpy()
            
            idx_sub = int(p_sub.argmax())
            idx_act = int(p_act.argmax())
            
            pred_sub = sub_keys[idx_sub]
            pred_act = act_keys[idx_act]
            
            conf_sub = p_sub[idx_sub] * 100.0
            conf_act = p_act[idx_act] * 100.0
            min_conf = min(conf_sub, conf_act)
            
            if pred_sub == expected_sub:
                hits_sub += 1
            if pred_act == expected_act:
                hits_act += 1
                
            flag_sub = "✓" if pred_sub == expected_sub else "✗"
            flag_act = "✓" if pred_act == expected_act else "✗"
            
            clean_phrase = phrase if len(phrase) <= 48 else phrase[:45] + "..."
            print(f"{clean_phrase:<50} | {pred_sub:<12} {flag_sub} | {pred_act:<12} {flag_act} | {min_conf:4.1f}% | {lat:5.1f} ms")
            
    print("-" * 105)
    print(f"\n📊 RESUMEN FINAL DE LA PRUEBA:")
    print(f"- Total frases evaluadas:  {total}")
    print(f"- Acierto Subsistemas:     {hits_sub}/{total} ({hits_sub/total*100:.1f}%)")
    print(f"- Acierto Acciones:        {hits_act}/{total} ({hits_act/total*100:.1f}%)")
    print(f"- Latencia media decisión: {np.mean(latencies):.1f} ms")
    print(f"- Latencia mínima / máx:   {np.min(latencies):.1f} ms / {np.max(latencies):.1f} ms")
    
    empty_cache("cuda")
    print("[OK] VRAM liberada limpiamente.")

if __name__ == "__main__":
    run_tests()
