#!/usr/bin/env python3
"""
Servidor local HTTP para zenKev (TypeSafe System One API)
Expone Kev-4B v3 para el motor Rust/Gecko de Zen Browser.
Compatible con `nli_engine.rs` (ZEN_VOICE_KEV_ENDPOINT).
"""

import os
import sys
import json
import time
import torch
from http.server import HTTPServer, BaseHTTPRequestHandler

# Caches aislados (opcionales vía entorno)
if "HF_HOME" not in os.environ and os.path.exists("/mnt/d/Zen/cache_hf"):
    os.environ["HF_HOME"] = "/mnt/d/Zen/cache_hf"
if "UV_CACHE_DIR" not in os.environ and os.path.exists("/mnt/d/Zen/cache_uv"):
    os.environ["UV_CACHE_DIR"] = "/mnt/d/Zen/cache_uv"
if "CUDA_VISIBLE_DEVICES" not in os.environ:
    os.environ["CUDA_VISIBLE_DEVICES"] = "0"

from kev.checkpoint import Checkpoint, LoadOptions
from kev.data import materialize
from kev.device import default_device, empty_cache, sync

DEFAULT_LOCAL_PATH = r"D:\Zen\runs\zenkev-v6-strict" if os.name == "nt" else "/mnt/d/Zen/runs/zenkev-v6-strict"
HF_REPO_ID = "Ttotopo27/zenkev-v6"

MODEL_PATH = os.environ.get("ZENKEV_MODEL_PATH")
if not MODEL_PATH:
    if os.path.exists(DEFAULT_LOCAL_PATH):
        MODEL_PATH = DEFAULT_LOCAL_PATH
    else:
        # Descarga o resuelve automáticamente desde Hugging Face
        try:
            from huggingface_hub import snapshot_download
            print(f"[zenKev-bridge] Modelo local no encontrado. Descargando/verificando {HF_REPO_ID} desde Hugging Face...")
            MODEL_PATH = snapshot_download(repo_id=HF_REPO_ID)
        except Exception as e:
            MODEL_PATH = HF_REPO_ID

HOST = os.environ.get("ZENKEV_HOST", "127.0.0.1")
PORT = int(os.environ.get("ZENKEV_PORT", 8080))

global_tok = None
global_model = None

class KevServerHandler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        # Log limpio y breve
        sys.stderr.write(f"[zenKev-bridge] {self.address_string()} - {format%args}\n")

    def do_GET(self):
        if self.path == "/health":
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(b'{"status":"ok","model":"zenkev-v6-strict"}')
        else:
            self.send_response(404)
            self.end_headers()

    def do_POST(self):
        content_len = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(content_len).decode("utf-8")
        
        try:
            req_data = json.loads(body)
        except Exception as e:
            self.send_response(400)
            self.end_headers()
            self.wfile.write(json.dumps({"error": f"JSON invalido: {e}"}).encode())
            return

        t0 = time.perf_counter()
        
        # Modo 1: Endpoint de decisión de candidatos Rust (nli_engine.rs)
        # Recibe: {"question": "...", "choices": ["candidato1", "candidato2", ...]}
        if "choices" in req_data:
            transcript = req_data.get("question", "")
            choices = req_data.get("choices", [])
            
            if not choices:
                self.send_response(400)
                self.end_headers()
                self.wfile.write(b'{"error":"choices no puede estar vacio"}')
                return

            criteria_map = {f"c_{i}": desc for i, desc in enumerate(choices)}
            k_req = {
                "state": transcript,
                "questions": {
                    "target": {
                        "type": "choice",
                        "instructions": "¿Cuál opción describe mejor la orden del usuario?",
                        "criteria": criteria_map,
                        "label": "c_0", # dummy
                        "src": "zenkev"
                    }
                }
            }
            
            with torch.no_grad():
                rec = materialize(k_req)
                enc = global_model.encode(global_tok, rec, strict=True)
                probs = global_model.probs(enc)[0].numpy()
                sync("cuda")
                
                choice_idx = int(probs.argmax())
                confidence = float(probs[choice_idx])

            elapsed_ms = (time.perf_counter() - t0) * 1000.0
            resp_payload = {
                "choice": choice_idx,
                "choice_name": choices[choice_idx] if choice_idx < len(choices) else "",
                "confidence": confidence,
                "latency_ms": round(elapsed_ms, 2)
            }

        # Modo 2: Triage Completo (Subsistema + Acción)
        # Recibe: {"transcript": "cierra la pestaña de youtube"}
        else:
            transcript = req_data.get("transcript", "")
            subsystems = {
                "browser_tabs": "Gestion de pestanas, ventanas y navegacion del navegador",
                "aom_dom": "Interaccion con elementos dentro de la pagina web actual",
                "vlm_vision": "Inspeccion de botones mudos o iconos sin texto mediante vision",
                "screen_reader": "Lectura asistida de texto o sintesis de accesibilidad",
                "llm_agent": "Preguntas conversacionales o consultas generales ajenas al control del navegador"
            }
            actions = {
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

            k_req = {
                "state": transcript,
                "questions": {
                    "subsystem": {
                        "type": "choice",
                        "instructions": "A que subsistema de ZenKev pertenece esta orden?",
                        "criteria": subsystems,
                        "label": "browser_tabs",
                        "src": "zenkev"
                    },
                    "action": {
                        "type": "choice",
                        "instructions": "Cual es la accion concreta a ejecutar?",
                        "criteria": actions,
                        "label": "close_tab",
                        "src": "zenkev"
                    }
                }
            }

            with torch.no_grad():
                rec = materialize(k_req)
                enc = global_model.encode(global_tok, rec, strict=True)
                probs = global_model.probs(enc)
                sync("cuda")
                
                p_sub = probs[0].numpy()
                p_act = probs[1].numpy()
                
                sub_keys = list(subsystems.keys())
                act_keys = list(actions.keys())
                
                idx_sub = int(p_sub.argmax())
                idx_act = int(p_act.argmax())
                
                elapsed_ms = (time.perf_counter() - t0) * 1000.0
                resp_payload = {
                    "transcript": transcript,
                    "subsystem": sub_keys[idx_sub],
                    "subsystem_conf": float(p_sub[idx_sub]),
                    "action": act_keys[idx_act],
                    "action_conf": float(p_act[idx_act]),
                    "latency_ms": round(elapsed_ms, 2)
                }

        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps(resp_payload).encode("utf-8"))

def run():
    global global_tok, global_model
    print("=================================================================")
    print("🚀 INICIANDO PUENTE LOCAL ZENKEV BRIDGE (Kev-4B v3)")
    print(f"Modelo: {MODEL_PATH}")
    print(f"Puerto: http://{HOST}:{PORT}")
    print("=================================================================")
    
    t0 = time.time()
    global_tok, global_model = Checkpoint(MODEL_PATH).load(device=torch.device("cuda"), opts=LoadOptions(dtype=torch.bfloat16))
    global_model.eval()
    print(f"[OK] Kev-4B v3 cargado y listo en VRAM ({time.time() - t0:.2f}s)")
    
    server = HTTPServer((HOST, PORT), KevServerHandler)
    print(f"[OK] Servidor escuchando peticiones en http://{HOST}:{PORT}/choice")
    print("Presiona Ctrl+C para detener el servidor.\n")
    
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nDeteniendo servidor...")
        server.server_close()
        empty_cache("cuda")
        print("[OK] VRAM liberada limpiamente.")

if __name__ == "__main__":
    run()
