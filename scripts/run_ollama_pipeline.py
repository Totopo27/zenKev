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

LANGUAGE_PROFILES = [
    "Español Rioplatense y Coloquial (Argentina, Uruguay)",
    "Español Neutro y Latinoamericano (México, Colombia, Chile)",
    "Español Peninsular (España)",
    "Inglés Americano y Británico (US/UK)",
    "Portugués (Brasil) y Francés"
]

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

def main():
    target = 1000
    out_file = "data/zenkev_ollama_1k.jsonl"
    os.makedirs("data", exist_ok=True)
    
    existing_count = 0
    existing_states = set()
    if os.path.exists(out_file):
        with open(out_file, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line:
                    try:
                        d = json.loads(line)
                        existing_states.add(d["state"].lower())
                        existing_count += 1
                    except Exception:
                        pass

    # Tambien evitar duplicados con el dataset v1
    v1_file = "data/zenkev_5k.jsonl"
    if os.path.exists(v1_file):
        with open(v1_file, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line:
                    try:
                        d = json.loads(line)
                        existing_states.add(d["state"].lower())
                    except Exception:
                        pass

    print(f"=== OLLAMA GENERATOR (Objetivo: {target} registros nuevos) ===")
    print(f"Progreso actual: {existing_count}/{target}")

    url = "http://localhost:11434/api/chat"
    idx = 0
    with httpx.Client(timeout=45.0) as client:
        while existing_count < target:
            prof = LANGUAGE_PROFILES[idx % len(LANGUAGE_PROFILES)]
            idx += 1

            system_prompt = (
                "Eres un generador especializado de datasets para zenKev (control por voz en Zen Browser).\n"
                "Genera entre 5 y 10 ordenes de voz humanas variadas y realistas.\n"
                "REGLA CRUCIAL: Devuelve UNICAMENTE un arreglo JSON de objetos con las llaves: 'state', 'subsystem', 'action'.\n"
                "Sin explicaciones, sin texto antes ni despues, sin formato markdown.\n\n"
                "Subsistemas validos: ['browser_tabs', 'aom_dom', 'vlm_vision', 'screen_reader', 'llm_agent']\n"
                "Acciones validas: ['close_tab', 'new_tab', 'switch_tab', 'scroll', 'click', 'inspect_icon', 'read_content', 'delegate_chat', 'none']"
            )
            user_prompt = f"Genera ordenes de voz unicas en el perfil: '{prof}'. Variar entre pestanas, scroll, clics, lectura, iconos mudos y charla casual."

            payload = {
                "model": "qwen2.5:3b",
                "messages": [
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_prompt}
                ],
                "format": "json",
                "stream": False,
                "options": {"temperature": 0.85}
            }

            try:
                r = client.post(url, json=payload)
                if r.status_code == 200:
                    raw = r.json()["message"]["content"].strip()
                    data = json.loads(raw)
                    if isinstance(data, dict):
                        for k in ["examples", "records", "data", "items"]:
                            if k in data and isinstance(data[k], list):
                                data = data[k]
                                break
                        if isinstance(data, dict):
                            data = [data]

                    new_added = 0
                    with open(out_file, "a", encoding="utf-8") as f:
                        for it in data:
                            st = it.get("state", "").strip()
                            sub = it.get("subsystem", "").strip()
                            act = it.get("action", "").strip()
                            st_lower = st.lower()
                            if st and st_lower not in existing_states and sub in WORKLOAD_SPEC["subsystems"] and act in WORKLOAD_SPEC["actions"]:
                                rec = format_kev_record(st, sub, act)
                                f.write(json.dumps(rec, ensure_ascii=False) + "\n")
                                existing_states.add(st_lower)
                                existing_count += 1
                                new_added += 1
                                if existing_count >= target:
                                    break
                    if new_added > 0:
                        print(f"  [+] Sumados {new_added} registros. Progreso: {existing_count}/{target} ({existing_count/target*100:.1f}%)")
            except Exception as e:
                time.sleep(2.0)

    print("\n[EXITO] Generacion de 1,000 registros con Ollama finalizada!")

if __name__ == "__main__":
    main()
