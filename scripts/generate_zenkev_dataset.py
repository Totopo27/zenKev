import os
import json
import asyncio
from typing import List, Dict, Any
import httpx

# Configuración del esquema para zenKev
WORKLOAD_SPEC = {
    "domain": "zenKev Voice Navigation & Subsystem Triage",
    "languages": ["es", "en", "pt", "fr"],
    "subsystems": [
        "browser_tabs",   # Pestañas, ventanas, historial
        "aom_dom",        # Clics, scroll, enlaces en página web
        "vlm_vision",     # Iconos mudos o botones gráficos
        "screen_reader",  # Lectura de contenido, accesibilidad
        "llm_agent"       # Preguntas conversacionales o ajenas al navegador
    ],
    "actions": [
        "close_tab", "new_tab", "switch_tab", "scroll",
        "click", "inspect_icon", "read_content", "delegate_chat", "none"
    ]
}

class GeminiRotator:
    def __init__(self, keys: List[str]):
        self.keys = keys
        self.current_idx = 0
        self.exhausted_keys = set()

    def get_active_key(self) -> str:
        if len(self.exhausted_keys) >= len(self.keys):
            raise RuntimeError("Todas las API keys de Gemini han agotado su cuota por hoy.")
        
        while self.current_idx in self.exhausted_keys:
            self.current_idx = (self.current_idx + 1) % len(self.keys)
            
        return self.keys[self.current_idx]

    def mark_exhausted(self):
        print(f"⚠️ Clave índice {self.current_idx} agotó cuota (429/ResourceExhausted). Rotando...")
        self.exhausted_keys.add(self.current_idx)
        self.current_idx = (self.current_idx + 1) % len(self.keys)


def load_keys() -> List[str]:
    keys = []
    if os.path.exists(".env.keys"):
        with open(".env.keys", "r", encoding="utf-8") as f:
            for line in f:
                if line.startswith("GEMINI_API_KEYS="):
                    val = line.strip().split("=", 1)[1].strip("\"'")
                    keys = [k.strip() for k in val.split(",") if k.strip()]
                    break
    return keys

# Plantilla para generar un registro válido de Kev
def format_kev_record(state: str, subsystem: str, action: str) -> Dict[str, Any]:
    return {
        "state": state,
        "questions": {
            "subsystem": {
                "type": "choice",
                "instructions": "¿A qué subsistema de ZenKev pertenece esta orden?",
                "criteria": {
                    "browser_tabs": "Gestión de pestañas, ventanas y navegación del navegador",
                    "aom_dom": "Interacción con elementos dentro de la página web actual",
                    "vlm_vision": "Inspección de botones mudos o iconos sin texto mediante visión",
                    "screen_reader": "Lectura asistida de texto o síntesis de accesibilidad",
                    "llm_agent": "Preguntas conversacionales o consultas generales ajenas al control del navegador"
                },
                "label": subsystem
            },
            "action": {
                "type": "choice",
                "instructions": "¿Cuál es la acción concreta a ejecutar?",
                "criteria": {
                    "close_tab": "Cerrar la pestaña actual o indicada",
                    "new_tab": "Abrir una nueva pestaña",
                    "switch_tab": "Cambiar a otra pestaña",
                    "scroll": "Desplazar la vista hacia arriba o abajo",
                    "click": "Activar un botón o enlace",
                    "inspect_icon": "Capturar recorte gráfico para clasificar icono",
                    "read_content": "Anunciar o leer contenido accesible",
                    "delegate_chat": "Delegar al asistente conversacional",
                    "none": "Comando ambiguo, ruido o conversación casual sin acción"
                },
                "label": action
            }
        }
    }

if __name__ == "__main__":
    keys = load_keys()
    print(f"[OK] Cargadas {len(keys)} claves de Gemini desde .env.keys.")
    print("Esquema zenKev configurado correctamente para generacion de 5k registros.")
