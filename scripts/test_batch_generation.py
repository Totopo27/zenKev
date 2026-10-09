import os
import json
import asyncio
from typing import List, Dict, Any
import httpx

# 1. Esquema y dominio de zenKev
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

# 2. Formateador estricto para Kev
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

# 3. Lógica de generación via OpenRouter (Space Bunny / Gemini Flash)
async def generate_batch_openrouter(api_key: str, batch_size: int, language_focus: str) -> List[Dict[str, Any]]:
    system_prompt = (
        "Eres un generador de datasets de entrenamiento para zenKev, un motor de control por voz del navegador Zen Browser.\n"
        "Debes generar ejemplos diversos, realistas y naturales de lo que diria un usuario humano.\n"
        "Incluye variaciones de tono, lenguaje coloquial, errores menores de habla, ordenes directas y casos negativos.\n\n"
        "Subsistemas validos: ['browser_tabs', 'aom_dom', 'vlm_vision', 'screen_reader', 'llm_agent']\n"
        "Acciones validas: ['close_tab', 'new_tab', 'switch_tab', 'scroll', 'click', 'inspect_icon', 'read_content', 'delegate_chat', 'none']\n\n"
        "Formato de respuesta OBLIGATORIO: Devuelve UNICAMENTE un arreglo JSON valido de objetos con las llaves: 'state', 'subsystem', 'action'.\n"
        "Sin explicaciones, sin markdown de bloques de codigo."
    )

    user_prompt = (
        f"Genera exactamente {batch_size} ejemplos unicos de ordenes de voz con enfoque en idioma/variante: '{language_focus}'.\n"
        "Asegurate de que haya un balance de acciones:\n"
        "- Algunas de pestanas (cerrar, abrir, cambiar)\n"
        "- Algunas de navegacion en pagina (scroll, clic)\n"
        "- Algunas de iconos mudos sin etiqueta de texto (ej: boton con forma de engranaje o lupa)\n"
        "- Algunas de lectura de pantalla para no videntes\n"
        "- Algunas de preguntas generales o frases casuales que deben ir a llm_agent con accion 'delegate_chat' o 'none'."
    )

    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        "HTTP-Referer": "https://zenkev.local",
        "X-Title": "zenKev-Dataset-Generator"
    }

    payload = {
        "model": "google/gemini-2.5-flash",
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt}
        ],
        "max_tokens": 4000,
        "temperature": 0.8
    }

    async with httpx.AsyncClient(timeout=45.0) as client:
        r = await client.post("https://openrouter.ai/api/v1/chat/completions", headers=headers, json=payload)
        if r.status_code != 200:
            raise RuntimeError(f"Error OpenRouter {r.status_code}: {r.text}")
        
        data = r.json()
        raw_text = data["choices"][0]["message"]["content"].strip()
        
        # Limpieza si viene envuelto en markdown
        if raw_text.startswith("```"):
            raw_text = raw_text.split("\n", 1)[1]
            if raw_text.endswith("```"):
                raw_text = raw_text.rsplit("\n", 1)[0]
                
        items = json.loads(raw_text)
        
        records = []
        for it in items:
            state = it["state"].strip()
            sub = it["subsystem"].strip()
            act = it["action"].strip()
            if sub in WORKLOAD_SPEC["subsystems"] and act in WORKLOAD_SPEC["actions"]:
                records.append(format_kev_record(state, sub, act))
        return records

async def run_test_generation():
    # Leer la key de OpenRouter que esta configurada en el catalogo
    or_key = None
    env_cat = r"D:\DocumentosDiscoD\catalogo-herramientas-skills\.env"
    if os.path.exists(env_cat):
        with open(env_cat, "r", encoding="utf-8") as f:
            for line in f:
                if line.startswith("OPENROUTER_API_KEY="):
                    or_key = line.strip().split("=", 1)[1].strip()
                    break

    if not or_key:
        print("[ERROR] No se encontro OPENROUTER_API_KEY en catalogo-herramientas-skills/.env")
        return

    print("=== TEST DE GENERACION: LOTE PILOTO DE 20 EJEMPLOS ===")
    os.makedirs("data", exist_ok=True)
    out_file = "data/zenkev_test_20.jsonl"
    
    records = await generate_batch_openrouter(or_key, 20, "Español (Rioplatense + Neutro) y algunos en Ingles")
    print(f"[OK] Generados {len(records)} registros validos segun el esquema de Kev.")
    
    with open(out_file, "w", encoding="utf-8") as f:
        for r in records:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
            
    print(f"[OK] Archivo guardado en: {out_file}")
    print("\n--- MUESTRAS DE LOS PRIMEROS 3 REGISTROS ---")
    for i, r in enumerate(records[:3]):
        print(f"\n[Muestra #{i+1}]")
        print(f"  Frase (State): \"{r['state']}\"")
        print(f"  Subsistema:    {r['questions']['subsystem']['label']}")
        print(f"  Accion:        {r['questions']['action']['label']}")

if __name__ == "__main__":
    asyncio.run(run_test_generation())
