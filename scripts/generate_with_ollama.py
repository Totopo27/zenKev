import os
import json
import httpx
import time

WORKLOAD_SPEC = {
    "domain": "zenKev Voice Navigation & Subsystem Triage",
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

def format_kev_record(state: str, subsystem: str, action: str):
    return {
        "state": state,
        "questions": {
            "subsystem": {
                "type": "choice",
                "instructions": "A que subsistema de ZenKev pertenece esta orden?",
                "criteria": WORKLOAD_SPEC["subsystems"],
                "label": subsystem
            },
            "action": {
                "type": "choice",
                "instructions": "Cual es la accion concreta a ejecutar?",
                "criteria": WORKLOAD_SPEC["actions"],
                "label": action
            }
        }
    }

def generate_with_ollama(model_name: str, batch_size: int, profile: str):
    url = "http://localhost:11434/api/chat"
    system_prompt = (
        "Eres un generador especializado de datasets para zenKev (control por voz en Zen Browser).\n"
        "Genera ordenes de voz humanas variadas y realistas.\n"
        "REGLA CRUCIAL: Devuelve UNICAMENTE un arreglo JSON de objetos con las llaves: 'state', 'subsystem', 'action'.\n"
        "Sin explicaciones, sin texto antes ni despues, sin formato markdown.\n\n"
        "Subsistemas validos: ['browser_tabs', 'aom_dom', 'vlm_vision', 'screen_reader', 'llm_agent']\n"
        "Acciones validas: ['close_tab', 'new_tab', 'switch_tab', 'scroll', 'click', 'inspect_icon', 'read_content', 'delegate_chat', 'none']"
    )
    user_prompt = (
        f"Genera exactamente {batch_size} ejemplos de ordenes de voz con enfoque en: '{profile}'.\n"
        "Incluye variedad de pestanas, clics en la web, lectura accesible, iconos mudos y charla casual."
    )
    
    payload = {
        "model": model_name,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt}
        ],
        "format": "json",
        "stream": False,
        "options": {
            "temperature": 0.85
        }
    }
    
    with httpx.Client(timeout=120.0) as client:
        r = client.post(url, json=payload)
        if r.status_code != 200:
            raise RuntimeError(f"Ollama error {r.status_code}: {r.text}")
        
        content = r.json()["message"]["content"].strip()
        data = json.loads(content)
        
        # En caso de que el modelo retorne un diccionario con una llave contenedora
        if isinstance(data, dict):
            for k in ["examples", "records", "data", "items"]:
                if k in data and isinstance(data[k], list):
                    data = data[k]
                    break
            if isinstance(data, dict):
                data = [data]
                
        records = []
        for it in data:
            st = it.get("state", "").strip()
            sub = it.get("subsystem", "").strip()
            act = it.get("action", "").strip()
            if st and sub in WORKLOAD_SPEC["subsystems"] and act in WORKLOAD_SPEC["actions"]:
                records.append(format_kev_record(st, sub, act))
        return records

if __name__ == "__main__":
    out_file = "data/zenkev_ollama_1k.jsonl"
    target = 1000
    model = "qwen2.5:3b" # Extremadamente rapido para inferencia local continua
    
    print(f"=== GENERADOR OLLAMA (Objetivo: {target} registros) ===")
    print(f"Modelo seleccionado: {model}")
    print(f"Almacenamiento: {out_file}")
    
    # Test inicial de 5 ejemplos
    print("\n[Ejecutando test inicial de 5 registros...]")
    test_recs = generate_with_ollama(model, 5, "Español Rioplatense y Neutro")
    print(f"[OK] Generados {len(test_recs)} registros con exito:")
    for r in test_recs[:2]:
        print(f"  - \"{r['state']}\" -> {r['questions']['subsystem']['label']} | {r['questions']['action']['label']}")
