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
    out_file = "data/zenkev_ollama_round2_1k.jsonl"
    os.makedirs("data", exist_ok=True)
    
    existing_count = 0
    existing_states = set()
    
    # 1. Cargar existentes en round2
    if os.path.exists(out_file):
        with open(out_file, "r", encoding="utf-8") as f:
            for line in f:
                if line.strip():
                    try:
                        d = json.loads(line)
                        existing_states.add(d["state"].strip().lower())
                        existing_count += 1
                    except Exception:
                        pass

    # 2. Cargar historico para no repetir
    for hist in ["data/zenkev_5k.jsonl", "data/zenkev_ollama_1k.jsonl"]:
        if os.path.exists(hist):
            with open(hist, "r", encoding="utf-8") as f:
                for line in f:
                    if line.strip():
                        try:
                            d = json.loads(line)
                            existing_states.add(d["state"].strip().lower())
                        except Exception:
                            pass

    print(f"=== OLLAMA GENERATOR ROUND 2 (Objetivo: {target} registros nuevos) ===")
    print(f"Progreso actual: {existing_count}/{target}")

    url = "http://localhost:11434/api/chat"
    idx = 0
    with httpx.Client(timeout=45.0) as client:
        while existing_count < target:
            prof = LANGUAGE_PROFILES[idx % len(LANGUAGE_PROFILES)]
            idx += 1

            system_prompt = (
                "Eres un generador especializado de datasets para zenKev (control por voz en Zen Browser).\n"
                "Genera entre 5 y 10 órdenes de voz humanas realistas y concretas.\n"
                "IMPORTANTE: Cada orden debe ser una frase o comando directo que un usuario real diría al navegador.\n"
                "NO generes títulos como 'Voice Commands', ni descripciones abstractas, ni mensajes de sistema.\n"
                "Devuelve ÚNICAMENTE un arreglo JSON de objetos con las llaves: 'state', 'subsystem', 'action'.\n"
                "Sin formato markdown, sin explicaciones.\n\n"
                "Subsistemas válidos: ['browser_tabs', 'aom_dom', 'vlm_vision', 'screen_reader', 'llm_agent']\n"
                "Acciones válidas: ['close_tab', 'new_tab', 'switch_tab', 'scroll', 'click', 'inspect_icon', 'read_content', 'delegate_chat', 'none']"
            )
            user_prompt = (
                f"Genera ejemplos de órdenes de voz humanas en el perfil: '{prof}'.\n"
                "Equilibra entre:\n"
                "- Pestañas (abrir, cerrar, cambiar pestaña específica)\n"
                "- Navegación web (scroll, clics en enlaces/botones)\n"
                "- Visión (preguntar por iconos gráficos sin texto)\n"
                "- Lectura accesible (leer párrafo, titular, resumen)\n"
                "- Asistente/charla (preguntas generales que no tocan el navegador)\n"
                "- Ruido/duda (interjecciones casuales que van a 'none')"
            )

            payload = {
                "model": "qwen2.5:3b",
                "messages": [
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_prompt}
                ],
                "options": {
                    "temperature": 0.85
                },
                "stream": False
            }

            try:
                res = client.post(url, json=payload)
                if res.status_code == 200:
                    raw = res.json().get("message", {}).get("content", "").strip()
                    if raw.startswith("```"):
                        raw = raw.split("\n", 1)[1]
                        if raw.endswith("```"):
                            raw = raw.rsplit("\n", 1)[0]
                    items = json.loads(raw)
                    if isinstance(items, list):
                        new_batch = []
                        for it in items:
                            st = it.get("state", "").strip()
                            sub = it.get("subsystem", "").strip()
                            act = it.get("action", "").strip()
                            if st and sub in WORKLOAD_SPEC["subsystems"] and act in WORKLOAD_SPEC["actions"]:
                                # Filtrar ruido evidente de meta-prompts
                                if any(bad in st.lower() for bad in ["voice command", "generation", "initializing", "preparing_"]):
                                    continue
                                if st.lower() not in existing_states:
                                    existing_states.add(st.lower())
                                    new_batch.append(format_kev_record(st, sub, act))

                        if new_batch:
                            with open(out_file, "a", encoding="utf-8") as f:
                                for rec in new_batch:
                                    f.write(json.dumps(rec, ensure_ascii=False) + "\n")
                            existing_count += len(new_batch)
                            print(f"[+] +{len(new_batch)} registros guardados. Total: {existing_count}/{target} ({existing_count/target*100:.1f}%)", flush=True)
                else:
                    print(f"[!] Error Ollama: HTTP {res.status_code}")
                    time.sleep(2)
            except Exception as e:
                time.sleep(1)

    print("\n[OK] Generacion Round 2 completada exitosamente.")

if __name__ == "__main__":
    main()
