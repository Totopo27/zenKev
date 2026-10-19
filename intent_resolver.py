"""
intent_resolver.py - Módulo profundo para resolver Command Intents desde transcripciones de audio.
Cumple con la especificación ADR-0001.
"""
from typing import Any, Dict, Optional
import urllib.parse
import re

SITE_MAP = {
    "wikipedia": "https://es.wikipedia.org",
    "google": "https://www.google.com",
    "youtube": "https://www.youtube.com",
    "github": "https://www.github.com",
    "reddit": "https://www.reddit.com",
    "twitter": "https://x.com",
    "x": "https://x.com",
    "facebook": "https://www.facebook.com",
    "instagram": "https://www.instagram.com",
    "whatsapp": "https://web.whatsapp.com",
    "gmail": "https://mail.google.com",
    "amazon": "https://www.amazon.com",
    "noticias": "https://news.google.com",
    "traductor": "https://translate.google.com",
}


def resolve_site_target(raw_target: str) -> Dict[str, Any]:
    clean = raw_target.lower().strip()

    if clean in SITE_MAP:
        return {"target": SITE_MAP[clean], "is_search": False}

    if clean.startswith("http://") or clean.startswith("https://"):
        return {"target": clean, "is_search": False}

    if re.match(r"^[a-z0-9-]+(\.[a-z0-9-]+)+(/.*)?$", clean):
        return {"target": f"https://{clean}", "is_search": False}

    encoded = urllib.parse.quote_plus(raw_target.strip())
    return {"target": f"https://www.google.com/search?q={encoded}", "is_search": True}



def resolve_command_intent(transcript: str, confidence: float = 1.0) -> Optional[Dict[str, Any]]:
    clean = transcript.strip().lower()

    if re.search(r"\b(baja|scroll abajo|desplazar abajo)\b", clean):
        return {
            "type": "command_intent",
            "action": "scroll",
            "params": {
                "direction": "down",
                "amount": 300,
            },
            "raw_transcript": transcript,
            "confidence": confidence,
        }

    if re.search(r"\b(sube|scroll arriba|desplazar arriba)\b", clean):
        return {
            "type": "command_intent",
            "action": "scroll",
            "params": {
                "direction": "up",
                "amount": 300,
            },
            "raw_transcript": transcript,
            "confidence": confidence,
        }

    if re.search(r"\b(?:silenciar|pausar|mutear)\s+voz\b", clean):
        return {
            "type": "command_intent",
            "action": "voice_state",
            "params": {
                "state": "muted",
            },
            "raw_transcript": transcript,
            "confidence": confidence,
        }

    if re.search(r"\b(?:activar|reanudar|desmutear)\s+voz\b", clean):
        return {
            "type": "command_intent",
            "action": "voice_state",
            "params": {
                "state": "active",
            },
            "raw_transcript": transcript,
            "confidence": confidence,
        }

    # Control de Historial
    if re.search(r"\b(?:ir\s+)?(?:atr[aá]s|volver|retroceder)|p[aá]gina\s+anterior\b", clean):
        return {
            "type": "command_intent",
            "action": "history_action",
            "params": {"operation": "back"},
            "raw_transcript": transcript,
            "confidence": confidence,
        }

    if re.search(r"\b(?:ir\s+)?(?:adelante|avanzar)|p[aá]gina\s+siguiente\b", clean):
        return {
            "type": "command_intent",
            "action": "history_action",
            "params": {"operation": "forward"},
            "raw_transcript": transcript,
            "confidence": confidence,
        }

    if re.search(r"\b(?:recargar|actualizar|refrescar)(?:\s+p[aá]gina)?\b", clean):
        return {
            "type": "command_intent",
            "action": "history_action",
            "params": {"operation": "reload"},
            "raw_transcript": transcript,
            "confidence": confidence,
        }

    # Control de Zoom
    if re.search(r"\b(?:zoom\s+m[aá]s|aumentar\s+zoom|m[aá]s\s+zoom)\b", clean):
        return {
            "type": "command_intent",
            "action": "zoom_action",
            "params": {"operation": "in"},
            "raw_transcript": transcript,
            "confidence": confidence,
        }

    if re.search(r"\b(?:zoom\s+menos|reducir\s+zoom|menos\s+zoom)\b", clean):
        return {
            "type": "command_intent",
            "action": "zoom_action",
            "params": {"operation": "out"},
            "raw_transcript": transcript,
            "confidence": confidence,
        }

    if re.search(r"\b(?:restablecer\s+zoom|zoom\s+normal|zoom\s+100)\b", clean):
        return {
            "type": "command_intent",
            "action": "zoom_action",
            "params": {"operation": "reset"},
            "raw_transcript": transcript,
            "confidence": confidence,
        }

    # Control de Ventanas
    if re.search(r"\b(?:(?:nueva\s+)?ventana\s+privada|(?:modo\s+)?inc[oó]gnito)\b", clean):
        return {
            "type": "command_intent",
            "action": "window_action",
            "params": {"operation": "new_private"},
            "raw_transcript": transcript,
            "confidence": confidence,
        }

    if re.search(r"\b(?:nueva|abrir|crear)\s+ventana\b", clean):
        return {
            "type": "command_intent",
            "action": "window_action",
            "params": {"operation": "new"},
            "raw_transcript": transcript,
            "confidence": confidence,
        }

    if re.search(r"\b(?:cerrar\s+(?:esta\s+)?ventana)\b", clean):
        return {
            "type": "command_intent",
            "action": "window_action",
            "params": {"operation": "close"},
            "raw_transcript": transcript,
            "confidence": confidence,
        }

    if re.search(r"\b(?:minimizar\s+ventana|minimizar)\b", clean):
        return {
            "type": "command_intent",
            "action": "window_action",
            "params": {"operation": "minimize"},
            "raw_transcript": transcript,
            "confidence": confidence,
        }

    if re.search(r"\b(?:maximizar\s+ventana|maximizar)\b", clean):
        return {
            "type": "command_intent",
            "action": "window_action",
            "params": {"operation": "maximize"},
            "raw_transcript": transcript,
            "confidence": confidence,
        }

    # Control de Marcadores
    if re.search(r"\b(?:marcar(?:\s+esta)?\s+p[aá]gina|guardar\s+(?:en\s+)?marcadores|guardar\s+marcador|a[nñ]adir\s+a\s+marcadores|agregar\s+a\s+marcadores)\b", clean):
        return {
            "type": "command_intent",
            "action": "bookmark_action",
            "params": {"operation": "save"},
            "raw_transcript": transcript,
            "confidence": confidence,
        }

    if re.search(r"\b(?:eliminar|quitar|borrar|remover)\s+marcador(?:\s+de\s+(?:esta\s+)?p[aá]gina)?|desmarcar(?:\s+esta)?\s+p[aá]gina\b", clean):
        return {
            "type": "command_intent",
            "action": "bookmark_action",
            "params": {"operation": "remove"},
            "raw_transcript": transcript,
            "confidence": confidence,
        }

    if re.search(r"\b(?:abrir|mostrar|ver|alternar)\s+(?:los\s+)?marcadores|barra\s+lateral\s+de\s+marcadores|panel\s+de\s+marcadores\b", clean):
        return {
            "type": "command_intent",
            "action": "bookmark_action",
            "params": {"operation": "toggle_sidebar"},
            "raw_transcript": transcript,
            "confidence": confidence,
        }

    if re.search(r"\b(?:biblioteca|organizador|gestor)\s+de\s+marcadores\b", clean):
        return {
            "type": "command_intent",
            "action": "bookmark_action",
            "params": {"operation": "library"},
            "raw_transcript": transcript,
            "confidence": confidence,
        }

    if re.search(r"\b(?:barra\s+de\s+marcadores|mostrar\s+barra\s+de\s+marcadores|alternar\s+barra\s+de\s+marcadores)\b", clean):
        return {
            "type": "command_intent",
            "action": "bookmark_action",
            "params": {"operation": "toggle_toolbar"},
            "raw_transcript": transcript,
            "confidence": confidence,
        }

    # Control de Descargas
    if re.search(r"\b(?:biblioteca|p[aá]gina|gestor)\s+de\s+descargas\b", clean):
        return {
            "type": "command_intent",
            "action": "download_action",
            "params": {"operation": "open_library"},
            "raw_transcript": transcript,
            "confidence": confidence,
        }

    if re.search(r"\b(?:limpiar|borrar|vaciar)\s+(?:las\s+)?descargas\b", clean):
        return {
            "type": "command_intent",
            "action": "download_action",
            "params": {"operation": "clear"},
            "raw_transcript": transcript,
            "confidence": confidence,
        }

    if re.search(r"\b(?:abrir|mostrar|ver)?\s*(?:las\s+)?descargas|panel\s+de\s+descargas|mis\s+descargas\b", clean):
        return {
            "type": "command_intent",
            "action": "download_action",
            "params": {"operation": "open_panel"},
            "raw_transcript": transcript,
            "confidence": confidence,
        }



    if re.search(r"\b(?:siguiente|pr[oó]xima)\s+pesta[ñn]a\b", clean):
        return {
            "type": "command_intent",
            "action": "tab_action",
            "params": {
                "operation": "next",
            },
            "raw_transcript": transcript,
            "confidence": confidence,
        }

    if re.search(r"\b(?:anterior|previa)\s+pesta[ñn]a\b", clean):
        return {
            "type": "command_intent",
            "action": "tab_action",
            "params": {
                "operation": "prev",
            },
            "raw_transcript": transcript,
            "confidence": confidence,
        }

    if re.search(r"\b(?:cerrar|cierra)\s+pesta[ñn]a\b", clean):
        return {
            "type": "command_intent",
            "action": "tab_action",
            "params": {
                "operation": "close",
            },
            "raw_transcript": transcript,
            "confidence": confidence,
        }

    if re.search(r"\b(?:nueva|crear|abrir)\s+pesta[ñn]a\b", clean):
        return {
            "type": "command_intent",
            "action": "tab_action",
            "params": {
                "operation": "new",
            },
            "raw_transcript": transcript,
            "confidence": confidence,
        }

    search_match = re.search(r"\b(?:buscar|busca|consultar)\s+(.+)$", clean)
    if search_match:
        query = search_match.group(1).strip()
        encoded = urllib.parse.quote_plus(query)
        return {
            "type": "command_intent",
            "action": "navigate",
            "params": {
                "target": f"https://www.google.com/search?q={encoded}",
                "is_search": True,
            },
            "raw_transcript": transcript,
            "confidence": confidence,
        }

    nav_match = re.search(r"\b(?:abrir|abre|ir a|navegar a)\s+(.+)$", clean)
    if nav_match:
        target_info = resolve_site_target(nav_match.group(1))
        return {
            "type": "command_intent",
            "action": "navigate",
            "params": target_info,
            "raw_transcript": transcript,
            "confidence": confidence,
        }

    badge_match = re.search(r"\b(?:clic(?: en)?(?: el)?|seleccionar|badge|opci[oó]n|n[uú]mero)\s+(\d+)\b", clean)



    if badge_match:
        return {
            "type": "command_intent",
            "action": "click_badge",
            "params": {
                "badge_index": int(badge_match.group(1)),
            },
            "raw_transcript": transcript,
            "confidence": confidence,
        }

    return None


