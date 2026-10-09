import os
import json
import asyncio
import time
from typing import List, Dict, Any
import httpx

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

def format_kev_record(state: str, subsystem: str, action: str) -> Dict[str, Any]:
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

LANGUAGE_PROFILES = [
    {"name": "Español Rioplatense y Coloquial (Argentina, Uruguay)", "weight": 30},
    {"name": "Español Neutro y Latinoamericano (México, Colombia, Chile)", "weight": 20},
    {"name": "Español Peninsular (España)", "weight": 10},
    {"name": "Inglés Americano y Británico (US/UK)", "weight": 30},
    {"name": "Portugués (Brasil) y Francés", "weight": 10}
]

async def generate_batch(client: httpx.AsyncClient, api_key: str, batch_size: int, profile_name: str) -> List[Dict[str, Any]]:
    system_prompt = (
        "Eres un generador especializado de datasets de entrenamiento para zenKev (control por voz en Zen Browser).\n"
        "Debes generar ordenes de voz humanas unicas, variadas y naturales.\n"
        "REGLA CRUCIAL: Devuelve UNICAMENTE un arreglo JSON valido de objetos con las llaves: 'state', 'subsystem', 'action'.\n"
        "Sin explicaciones, sin comentarios, sin markdown de bloques de codigo.\n\n"
        "Subsistemas validos: ['browser_tabs', 'aom_dom', 'vlm_vision', 'screen_reader', 'llm_agent']\n"
        "Acciones validas: ['close_tab', 'new_tab', 'switch_tab', 'scroll', 'click', 'inspect_icon', 'read_content', 'delegate_chat', 'none']"
    )

    user_prompt = (
        f"Genera exactamente {batch_size} ejemplos unicos de ordenes de voz en el perfil: '{profile_name}'.\n"
        "Diversifica las situaciones:\n"
        "- Gestion de pestanas: cerrar, abrir, duplicar, saltar a pestana especifica.\n"
        "- Navegacion en web: scroll rapido, scroll lento, hacer clic en enlaces o botones con texto.\n"
        "- Iconos mudos/vision: describir que hace un icono sin etiqueta visible (engranaje, lupa, campana, corazon).\n"
        "- Lectura accesible: leer encabezados, parrafos, resumen para usuarios no videntes.\n"
        "- Casos negativos y asistente: preguntas de conocimiento, chistes, ruido, peticiones que deben ir a 'delegate_chat' o 'none'."
    )

    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        "HTTP-Referer": "https://zenkev.local",
        "X-Title": "zenKev-5k-Generator"
    }

    payload = {
        "model": "google/gemini-2.5-flash",
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt}
        ],
        "max_tokens": 4000,
        "temperature": 0.85
    }

    response = await client.post("https://openrouter.ai/api/v1/chat/completions", headers=headers, json=payload, timeout=60.0)
    if response.status_code != 200:
        raise RuntimeError(f"HTTP {response.status_code}: {response.text}")

    data = response.json()
    raw_text = data["choices"][0]["message"]["content"].strip()

    if raw_text.startswith("```"):
        raw_text = raw_text.split("\n", 1)[1]
        if raw_text.endswith("```"):
            raw_text = raw_text.rsplit("\n", 1)[0]

    items = json.loads(raw_text)
    records = []
    for it in items:
        state = it.get("state", "").strip()
        sub = it.get("subsystem", "").strip()
        act = it.get("action", "").strip()
        if state and sub in WORKLOAD_SPEC["subsystems"] and act in WORKLOAD_SPEC["actions"]:
            records.append(format_kev_record(state, sub, act))
    return records

async def main():
    target_total = 5000
    batch_size = 50
    out_file = "data/zenkev_5k.jsonl"
    os.makedirs("data", exist_ok=True)

    or_key = None
    env_cat = r"D:\DocumentosDiscoD\catalogo-herramientas-skills\.env"
    if os.path.exists(env_cat):
        with open(env_cat, "r", encoding="utf-8") as f:
            for line in f:
                if line.startswith("OPENROUTER_API_KEY="):
                    or_key = line.strip().split("=", 1)[1].strip()
                    break

    if not or_key:
        print("[ERROR] OPENROUTER_API_KEY no encontrada.")
        return

    # Contar cuantos ya existen si se reanuda
    existing_count = 0
    existing_states = set()
    if os.path.exists(out_file):
        with open(out_file, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line:
                    try:
                        obj = json.loads(line)
                        existing_states.add(obj["state"].lower())
                        existing_count += 1
                    except Exception:
                        pass

    print(f"=== INICIANDO PIPELINE DE GENERACION ZENKEV (5,000 REGISTROS) ===")
    print(f"Progreso previo detectado: {existing_count}/{target_total} registros.")

    profile_idx = 0
    async with httpx.AsyncClient(timeout=60.0) as client:
        while existing_count < target_total:
            profile = LANGUAGE_PROFILES[profile_idx % len(LANGUAGE_PROFILES)]["name"]
            profile_idx += 1
            
            needed = min(batch_size, target_total - existing_count)
            print(f"\n[Generando lote de {needed}]: Perfil '{profile}'...")

            try:
                records = await generate_batch(client, or_key, needed, profile)
                new_records = []
                for r in records:
                    st_lower = r["state"].lower()
                    if st_lower not in existing_states:
                        existing_states.add(st_lower)
                        new_records.append(r)

                if new_records:
                    with open(out_file, "a", encoding="utf-8") as f:
                        for r in new_records:
                            f.write(json.dumps(r, ensure_ascii=False) + "\n")
                    existing_count += len(new_records)
                    print(f"  [+] Guardados {len(new_records)} registros nuevos. Total actual: {existing_count}/{target_total} ({existing_count/target_total*100:.1f}%)")
                else:
                    print("  [!] Lote duplicado o sin nuevos registros, reintentando con variaciones...")

                await asyncio.sleep(1.0) # Respetar rate limits amablemente
            except Exception as e:
                print(f"  [ERROR en lote]: {e}. Esperando 5s antes de reintentar...")
                await asyncio.sleep(5.0)

    print(f"\n=======================================================")
    print(f"[EXITO] Dataset de 5,000 ejemplos completado en {out_file}!")
    print(f"=======================================================")

if __name__ == "__main__":
    asyncio.run(main())
