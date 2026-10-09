#!/usr/bin/env python3
"""
Batería de pruebas en vivo para Kev-4B v4 a través del puente HTTP.
Enfocado en Español Neutral y comandos cotidianos de accesibilidad/navegación.
"""

import json
import time
import urllib.request

ENDPOINT = "http://127.0.0.1:8080/choice"

TEST_CASES = [
    # 1. Pestañas / Navegación del navegador (browser_tabs)
    ("Cierra la pestaña actual por favor", "browser_tabs", "close_tab"),
    ("Abre una pestaña nueva", "browser_tabs", "new_tab"),
    ("Cambia a la siguiente pestaña", "browser_tabs", "switch_tab"),
    ("Ve a la pestaña anterior", "browser_tabs", "switch_tab"),
    ("Cierra todas las pestañas de la derecha", "browser_tabs", "close_tab"),

    # 2. Interacción con la página actual / DOM (aom_dom)
    ("Desplaza la página hacia abajo", "aom_dom", "scroll"),
    ("Baja un poco en la pantalla", "aom_dom", "scroll"),
    ("Sube al inicio de la página", "aom_dom", "scroll"),
    ("Haz clic en el botón de aceptar términos", "aom_dom", "click"),
    ("Presiona el enlace que dice Contacto", "aom_dom", "click"),

    # 3. Visión e inspección gráfica de iconos (vlm_vision)
    ("¿Qué función tiene este icono de la campana?", "vlm_vision", "inspect_icon"),
    ("Describe el botón con forma de engranaje", "vlm_vision", "inspect_icon"),
    ("¿Qué significa la figura de la lupa arriba?", "vlm_vision", "inspect_icon"),

    # 4. Accesibilidad y lector de pantalla (screen_reader)
    ("Lee el contenido del artículo en voz alta", "screen_reader", "read_content"),
    ("Léeme el primer encabezado de la página", "screen_reader", "read_content"),
    ("Lee el texto seleccionado para mí", "screen_reader", "read_content"),

    # 5. Asistente general / Consultas conversacionales (llm_agent)
    ("¿Cuál es la distancia entre la Tierra y la Luna?", "llm_agent", "delegate_chat"),
    ("Explícame cómo funciona la fotosíntesis", "llm_agent", "delegate_chat"),
    ("¿Qué hora es en Tokio ahora mismo?", "llm_agent", "delegate_chat"),

    # 6. Ruido / Ambigüedad / Sin acción (none)
    ("Mmm... déjame pensarlo un segundo", "llm_agent", "none"),
    ("Hace un día muy soleado hoy", "llm_agent", "none"),
]

def query_bridge(transcript: str):
    data = json.dumps({"transcript": transcript}).encode("utf-8")
    req = urllib.request.Request(
        ENDPOINT,
        data=data,
        headers={"Content-Type": "application/json"}
    )
    t0 = time.perf_counter()
    with urllib.request.urlopen(req) as resp:
        res = json.loads(resp.read().decode("utf-8"))
    lat_ms = (time.perf_counter() - t0) * 1000.0
    return res, lat_ms

def main():
    print("=" * 80)
    print("🎙️ BATERÍA DE PRUEBAS EN VIVO — KEV-4B V4 (ESPAÑOL NEUTRAL)")
    print(f"Servidor: {ENDPOINT}")
    print(f"Total de casos: {len(TEST_CASES)}")
    print("=" * 80)

    sub_correct = 0
    act_correct = 0
    latencies = []

    for i, (text, exp_sub, exp_act) in enumerate(TEST_CASES, 1):
        try:
            res, lat = query_bridge(text)
            pred_sub = res.get("subsystem")
            pred_act = res.get("action")
            sub_conf = res.get("subsystem_conf", 0.0) * 100.0
            act_conf = res.get("action_conf", 0.0) * 100.0
            latencies.append(lat)

            sub_ok = (pred_sub == exp_sub)
            act_ok = (pred_act == exp_act)

            if sub_ok:
                sub_correct += 1
            if act_ok:
                act_correct += 1

            status_icon = "✅" if (sub_ok and act_ok) else ("⚠️" if (sub_ok or act_ok) else "❌")
            print(f"[{i:02d}/{len(TEST_CASES)}] {status_icon} '{text}' ({lat:.1f}ms)")
            print(f"     Subsistema: Esperado '{exp_sub}' | Predicho '{pred_sub}' ({sub_conf:.1f}%)")
            print(f"     Acción:     Esperado '{exp_act}' | Predicho '{pred_act}' ({act_conf:.1f}%)")
            print("-" * 80)
        except Exception as e:
            print(f"[{i:02d}/{len(TEST_CASES)}] ❌ Error consultando bridge: {e}")

    total = len(TEST_CASES)
    avg_lat = sum(latencies) / len(latencies) if latencies else 0.0
    print("\n" + "=" * 80)
    print("📊 RESUMEN DE LA BATERÍA EN ESPAÑOL NEUTRAL")
    print("=" * 80)
    print(f"🎯 Precisión Subsistema: {sub_correct}/{total} ({sub_correct/total*100:.1f}%)")
    print(f"🎯 Precisión Acción:     {act_correct}/{total} ({act_correct/total*100:.1f}%)")
    print(f"⚡ Latencia Promedio:    {avg_lat:.2f} ms")
    print("=" * 80)

if __name__ == "__main__":
    main()
