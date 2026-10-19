"""
Módulo profundo intent_resolver.py
Encapsula la resolución de lenguaje natural y sinónimos a Command Intents tipados
conforme a la arquitectura ADR-0001 de zenKev.
"""

import re
import urllib.parse
from typing import Any, Dict, Optional

SITE_MAP = {
    "youtube": "https://www.youtube.com",
    "google": "https://www.google.com",
    "github": "https://www.github.com",
    "twitter": "https://www.twitter.com",
    "x": "https://www.x.com",
    "reddit": "https://www.reddit.com",
    "wikipedia": "https://www.wikipedia.org",
}


def _make_intent(
    action: str,
    params: Optional[Dict[str, Any]] = None,
    transcript: str = "",
    confidence: float = 1.0,
) -> Dict[str, Any]:
    """Crea un sobre normalizado de Command Intent según contrato ADR-0001."""
    return {
        "type": "command_intent",
        "action": action,
        "params": params if params is not None else {},
        "raw_transcript": transcript,
        "confidence": confidence,
    }


def resolve_site_target(raw_target: str) -> Dict[str, Any]:
    clean = raw_target.strip().lower()

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

    # Desplazamiento (Scroll)
    if re.search(r"\b(baja|scroll abajo|desplazar abajo)\b", clean):
        return _make_intent("scroll", {"direction": "down", "amount": 300}, transcript, confidence)

    if re.search(r"\b(sube|scroll arriba|desplazar arriba)\b", clean):
        return _make_intent("scroll", {"direction": "up", "amount": 300}, transcript, confidence)

    # Estado del motor de voz
    if re.search(r"\b(?:silenciar|pausar|mutear)\s+voz\b", clean):
        return _make_intent("voice_state", {"state": "muted"}, transcript, confidence)

    if re.search(r"\b(?:activar|reanudar|desmutear)\s+voz\b", clean):
        return _make_intent("voice_state", {"state": "active"}, transcript, confidence)

    # Control de Historial
    if re.search(r"\b(?:cerrar\s+(?:(?:la\s+)?ventana\s+de\s+)?historial|cerrar\s+panel\s+de\s+historial|ocultar\s+historial)\b", clean):
        return _make_intent("history_action", {"operation": "close"}, transcript, confidence)

    if re.search(r"\b(?:abrir\s+ventana\s+de\s+historial|biblioteca\s+de\s+historial|gestor\s+de\s+historial)\b", clean):
        return _make_intent("history_action", {"operation": "open_library"}, transcript, confidence)

    if re.search(r"\b(?:abrir|mostrar|ver|alternar)\s+(?:el\s+)?historial|panel\s+de\s+historial|barra\s+lateral\s+de\s+historial\b", clean):
        return _make_intent("history_action", {"operation": "open_panel"}, transcript, confidence)

    if re.search(r"\b(?:ir\s+)?(?:atr[aá]s|volver|retroceder)|p[aá]gina\s+anterior\b", clean):
        return _make_intent("history_action", {"operation": "back"}, transcript, confidence)

    if re.search(r"\b(?:ir\s+)?(?:adelante|avanzar)|p[aá]gina\s+siguiente\b", clean):
        return _make_intent("history_action", {"operation": "forward"}, transcript, confidence)

    if re.search(r"\b(?:recargar|actualizar|refrescar)(?:\s+p[aá]gina)?\b", clean):
        return _make_intent("history_action", {"operation": "reload"}, transcript, confidence)

    # Control de Zoom
    if re.search(r"\b(?:zoom\s+m[aá]s|aumentar\s+zoom|m[aá]s\s+zoom)\b", clean):
        return _make_intent("zoom_action", {"operation": "in"}, transcript, confidence)

    if re.search(r"\b(?:zoom\s+menos|reducir\s+zoom|menos\s+zoom)\b", clean):
        return _make_intent("zoom_action", {"operation": "out"}, transcript, confidence)

    if re.search(r"\b(?:restablecer\s+zoom|zoom\s+normal|zoom\s+100)\b", clean):
        return _make_intent("zoom_action", {"operation": "reset"}, transcript, confidence)

    # Control de Marcadores
    if re.search(r"\b(?:cerrar\s+(?:(?:la\s+)?ventana\s+de\s+)?marcadores|cerrar\s+panel\s+de\s+marcadores|ocultar\s+marcadores)\b", clean):
        return _make_intent("bookmark_action", {"operation": "close"}, transcript, confidence)

    if re.search(r"\b(?:marcar(?:\s+esta)?\s+p[aá]gina|guardar\s+(?:en\s+)?marcadores|guardar\s+marcador|a[nñ]adir\s+a\s+marcadores|agregar\s+a\s+marcadores)\b", clean):
        return _make_intent("bookmark_action", {"operation": "save"}, transcript, confidence)

    if re.search(r"\b(?:eliminar|quitar|borrar|remover)\s+marcador(?:\s+de\s+(?:esta\s+)?p[aá]gina)?|desmarcar(?:\s+esta)?\s+p[aá]gina\b", clean):
        return _make_intent("bookmark_action", {"operation": "remove"}, transcript, confidence)

    if re.search(r"\b(?:(?:ir\s+a\s+|abrir\s+)?(?:la\s+)?ventana\s+de\s+marcadores|biblioteca\s+de\s+marcadores|organizador\s+de\s+marcadores|gestor\s+de\s+marcadores|^ventana\s+de\s+marcadores$)\b", clean):
        return _make_intent("bookmark_action", {"operation": "library"}, transcript, confidence)

    if re.search(r"\b(?:abrir|mostrar|ver|alternar)\s+(?:los\s+)?marcadores|barra\s+lateral\s+de\s+marcadores|panel\s+de\s+marcadores\b", clean):
        return _make_intent("bookmark_action", {"operation": "toggle_sidebar"}, transcript, confidence)

    if re.search(r"\b(?:barra\s+de\s+marcadores|mostrar\s+barra\s+de\s+marcadores|alternar\s+barra\s+de\s+marcadores)\b", clean):
        return _make_intent("bookmark_action", {"operation": "toggle_toolbar"}, transcript, confidence)

    # Control de Descargas
    if re.search(r"\b(?:cerrar\s+(?:(?:la\s+)?ventana\s+de\s+)?descargas|cerrar\s+panel\s+de\s+descargas|ocultar\s+descargas)\b", clean):
        return _make_intent("download_action", {"operation": "close"}, transcript, confidence)

    if re.search(r"\b(?:(?:ir\s+a\s+|abrir\s+)?(?:la\s+)?ventana\s+de\s+descargas|biblioteca\s+de\s+descargas|p[aá]gina\s+de\s+descargas|gestor\s+de\s+descargas|^ventana\s+de\s+descargas$)\b", clean):
        return _make_intent("download_action", {"operation": "open_library"}, transcript, confidence)

    if re.search(r"\b(?:limpiar|borrar|vaciar)\s+(?:las\s+)?descargas\b", clean):
        return _make_intent("download_action", {"operation": "clear"}, transcript, confidence)

    if re.search(r"\b(?:abrir|mostrar|ver)\s+(?:las\s+)?descargas|panel\s+de\s+descargas|mis\s+descargas|^descargas$\b", clean):
        return _make_intent("download_action", {"operation": "open_panel"}, transcript, confidence)

    # Control de Ventanas
    if re.search(r"\b(?:(?:nueva\s+)?ventana\s+privada|(?:modo\s+)?inc[oó]gnito)\b", clean):
        return _make_intent("window_action", {"operation": "new_private"}, transcript, confidence)

    if re.search(r"\b(?:nueva|abrir|crear)\s+ventana\b", clean) and not re.search(r"\b(?:descargas|marcadores|historial)\b", clean):
        return _make_intent("window_action", {"operation": "new"}, transcript, confidence)

    if re.search(r"\b(?:cerrar\s+(?:esta\s+)?ventana)\b", clean) and not re.search(r"\b(?:descargas|marcadores|historial)\b", clean):
        return _make_intent("window_action", {"operation": "close"}, transcript, confidence)

    if re.search(r"\b(?:minimizar\s+ventana|minimizar)\b", clean):
        return _make_intent("window_action", {"operation": "minimize"}, transcript, confidence)

    if re.search(r"\b(?:maximizar\s+ventana|maximizar)\b", clean):
        return _make_intent("window_action", {"operation": "maximize"}, transcript, confidence)

    # Control de Pestañas
    if re.search(r"\b(?:(?:ir\s+a\s+|abrir\s+)?pesta[ñn]a\s+nueva|nueva\s+pesta[ñn]a)\b", clean):
        return _make_intent("tab_action", {"operation": "new"}, transcript, confidence)

    tab_special_match = re.search(r"\b(?:abrir|nueva)\s+pesta[ñn]a\s+de\s+(descargas|marcadores|historial)\b", clean)
    if tab_special_match:
        target = tab_special_match.group(1)
        url_map = {
            "descargas": "about:downloads",
            "marcadores": "about:bookmarks",
            "historial": "about:history",
        }
        return _make_intent("tab_action", {"operation": "new", "url": url_map[target]}, transcript, confidence)

    tab_switch_match = re.search(r"\b(?:ir\s+a\s+|cambiar\s+a\s+|ver\s+)(?:la\s+)?pesta[ñn]a\s+(?:de\s+)?(.+)$", clean)
    if tab_switch_match:
        target_name = tab_switch_match.group(1).strip()
        return _make_intent("tab_action", {"operation": "switch", "target": target_name}, transcript, confidence)

    tab_close_target_match = re.search(r"\b(?:cerrar|cierra)\s+(?:la\s+)?pesta[ñn]a\s+de\s+(.+)$", clean)
    if tab_close_target_match:
        target_name = tab_close_target_match.group(1).strip()
        return _make_intent("tab_action", {"operation": "close", "target": target_name}, transcript, confidence)

    if re.search(r"\b(?:siguiente|pr[oó]xima)\s+pesta[ñn]a\b", clean):
        return _make_intent("tab_action", {"operation": "next"}, transcript, confidence)

    if re.search(r"\b(?:anterior|previa)\s+pesta[ñn]a\b", clean):
        return _make_intent("tab_action", {"operation": "prev"}, transcript, confidence)

    if re.search(r"\b(?:cerrar|cierra)\s+pesta[ñn]a\b", clean):
        return _make_intent("tab_action", {"operation": "close"}, transcript, confidence)

    if re.search(r"\b(?:nueva|crear|abrir)\s+pesta[ñn]a\b", clean):
        return _make_intent("tab_action", {"operation": "new"}, transcript, confidence)

    if re.search(r"\b(?:fijar|anclar|pinear)\s+pesta[ñn]a\b", clean):
        return _make_intent("tab_action", {"operation": "pin"}, transcript, confidence)

    if re.search(r"\b(?:desfijar|desanclar|despinear)\s+pesta[ñn]a\b", clean):
        return _make_intent("tab_action", {"operation": "unpin"}, transcript, confidence)

    if re.search(r"\b(?:duplicar|clonar)\s+pesta[ñn]a\b", clean):
        return _make_intent("tab_action", {"operation": "duplicate"}, transcript, confidence)

    if re.search(r"\b(?:silenciar|mutear)\s+pesta[ñn]a|(?:activar|desmutear)\s+(?:sonido|audio)\b", clean):
        return _make_intent("tab_action", {"operation": "toggle_mute"}, transcript, confidence)

    # Pantalla Completa
    if re.search(r"\bpantalla\s+completa\b", clean):
        return _make_intent("fullscreen_action", {"operation": "toggle"}, transcript, confidence)

    # Búsqueda Web
    search_match = re.search(r"\b(?:buscar|busca|consultar)\s+(.+)$", clean)
    if search_match:
        query = search_match.group(1).strip()
        encoded = urllib.parse.quote_plus(query)
        return _make_intent(
            "navigate",
            {"target": f"https://www.google.com/search?q={encoded}", "is_search": True},
            transcript,
            confidence,
        )

    # Navegación a Sitio Web o URL
    nav_match = re.search(r"\b(?:abrir|abre|ir a|navegar a)\s+(.+)$", clean)
    if nav_match:
        # No secuestrar comandos de entidades internas del navegador
        if not re.search(r"\b(?:pesta[ñn]a|ventana|descargas|marcadores|historial)\b", clean):
            target_info = resolve_site_target(nav_match.group(1))
            return _make_intent("navigate", target_info, transcript, confidence)

    # Badges Numéricos (AOM)
    badge_match = re.search(r"\b(?:clic(?: en)?(?: el)?|seleccionar|badge|opci[oó]n|n[uú]mero)\s+(\d+)\b", clean)
    if badge_match:
        return _make_intent(
            "click_badge",
            {"badge_index": int(badge_match.group(1))},
            transcript,
            confidence,
        )

    return None
