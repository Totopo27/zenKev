import pytest
from intent_resolver import resolve_command_intent


def test_resolve_scroll_down_intent():
    transcript = "baja un poco"
    intent = resolve_command_intent(transcript, confidence=0.92)

    assert intent == {
        "type": "command_intent",
        "action": "scroll",
        "params": {
            "direction": "down",
            "amount": 300,
        },
        "raw_transcript": "baja un poco",
        "confidence": 0.92,
    }


def test_resolve_scroll_up_intent():
    transcript = "sube un poco"
    intent = resolve_command_intent(transcript, confidence=0.88)

    assert intent == {
        "type": "command_intent",
        "action": "scroll",
        "params": {
            "direction": "up",
            "amount": 300,
        },
        "raw_transcript": "sube un poco",
        "confidence": 0.88,
    }


def test_resolve_click_badge_intent():
    transcript = "clic en el 4"
    intent = resolve_command_intent(transcript, confidence=0.95)

    assert intent == {
        "type": "command_intent",
        "action": "click_badge",
        "params": {
            "badge_index": 4,
        },
        "raw_transcript": "clic en el 4",
        "confidence": 0.95,
    }


def test_resolve_mute_unmute_voice_intent():
    mute_intent = resolve_command_intent("silenciar voz", confidence=0.99)
    assert mute_intent == {
        "type": "command_intent",
        "action": "voice_state",
        "params": {
            "state": "muted",
        },
        "raw_transcript": "silenciar voz",
        "confidence": 0.99,
    }

    unmute_intent = resolve_command_intent("activar voz", confidence=0.98)
    assert unmute_intent == {
        "type": "command_intent",
        "action": "voice_state",
        "params": {
            "state": "active",
        },
        "raw_transcript": "activar voz",
        "confidence": 0.98,
    }


def test_resolve_tab_actions():
    next_tab = resolve_command_intent("siguiente pestaña", confidence=0.93)
    assert next_tab == {
        "type": "command_intent",
        "action": "tab_action",
        "params": {
            "operation": "next",
        },
        "raw_transcript": "siguiente pestaña",
        "confidence": 0.93,
    }

    close_tab = resolve_command_intent("cerrar pestaña", confidence=0.96)
    assert close_tab == {
        "type": "command_intent",
        "action": "tab_action",
        "params": {
            "operation": "close",
        },
        "raw_transcript": "cerrar pestaña",
        "confidence": 0.96,
    }


def test_resolve_navigate_intent():
    site_intent = resolve_command_intent("abrir youtube", confidence=0.97)
    assert site_intent == {
        "type": "command_intent",
        "action": "navigate",
        "params": {
            "target": "https://www.youtube.com",
            "is_search": False,
        },
        "raw_transcript": "abrir youtube",
        "confidence": 0.97,
    }

    search_intent = resolve_command_intent("buscar cómo hacer masa madre", confidence=0.91)
    assert search_intent == {
        "type": "command_intent",
        "action": "navigate",
        "params": {
            "target": "https://www.google.com/search?q=c%C3%B3mo+hacer+masa+madre",
            "is_search": True,
        },
        "raw_transcript": "buscar cómo hacer masa madre",
        "confidence": 0.91,
    }


def test_resolve_history_actions():
    back_intent = resolve_command_intent("ir atrás", confidence=0.94)
    assert back_intent == {
        "type": "command_intent",
        "action": "history_action",
        "params": {"operation": "back"},
        "raw_transcript": "ir atrás",
        "confidence": 0.94,
    }

    forward_intent = resolve_command_intent("página siguiente", confidence=0.92)
    assert forward_intent == {
        "type": "command_intent",
        "action": "history_action",
        "params": {"operation": "forward"},
        "raw_transcript": "página siguiente",
        "confidence": 0.92,
    }

    reload_intent = resolve_command_intent("recargar página", confidence=0.96)
    assert reload_intent == {
        "type": "command_intent",
        "action": "history_action",
        "params": {"operation": "reload"},
        "raw_transcript": "recargar página",
        "confidence": 0.96,
    }


def test_resolve_zoom_actions():
    zoom_in = resolve_command_intent("aumentar zoom", confidence=0.93)
    assert zoom_in == {
        "type": "command_intent",
        "action": "zoom_action",
        "params": {"operation": "in"},
        "raw_transcript": "aumentar zoom",
        "confidence": 0.93,
    }

    zoom_out = resolve_command_intent("reducir zoom", confidence=0.91)
    assert zoom_out == {
        "type": "command_intent",
        "action": "zoom_action",
        "params": {"operation": "out"},
        "raw_transcript": "reducir zoom",
        "confidence": 0.91,
    }

    zoom_reset = resolve_command_intent("zoom normal", confidence=0.95)
    assert zoom_reset == {
        "type": "command_intent",
        "action": "zoom_action",
        "params": {"operation": "reset"},
        "raw_transcript": "zoom normal",
        "confidence": 0.95,
    }


def test_resolve_window_actions():
    new_win = resolve_command_intent("nueva ventana", confidence=0.95)
    assert new_win == {
        "type": "command_intent",
        "action": "window_action",
        "params": {"operation": "new"},
        "raw_transcript": "nueva ventana",
        "confidence": 0.95,
    }

    private_win = resolve_command_intent("ventana privada", confidence=0.94)
    assert private_win == {
        "type": "command_intent",
        "action": "window_action",
        "params": {"operation": "new_private"},
        "raw_transcript": "ventana privada",
        "confidence": 0.94,
    }

    close_win = resolve_command_intent("cerrar ventana", confidence=0.97)
    assert close_win == {
        "type": "command_intent",
        "action": "window_action",
        "params": {"operation": "close"},
        "raw_transcript": "cerrar ventana",
        "confidence": 0.97,
    }


def test_resolve_bookmark_actions():
    save_bm = resolve_command_intent("guardar marcador", confidence=0.96)
    assert save_bm == {
        "type": "command_intent",
        "action": "bookmark_action",
        "params": {"operation": "save"},
        "raw_transcript": "guardar marcador",
        "confidence": 0.96,
    }

    del_bm = resolve_command_intent("eliminar marcador", confidence=0.93)
    assert del_bm == {
        "type": "command_intent",
        "action": "bookmark_action",
        "params": {"operation": "remove"},
        "raw_transcript": "eliminar marcador",
        "confidence": 0.93,
    }

    toggle_bm = resolve_command_intent("panel de marcadores", confidence=0.94)
    assert toggle_bm == {
        "type": "command_intent",
        "action": "bookmark_action",
        "params": {"operation": "toggle_sidebar"},
        "raw_transcript": "panel de marcadores",
        "confidence": 0.94,
    }


def test_resolve_download_actions():
    open_dl = resolve_command_intent("abrir descargas", confidence=0.95)
    assert open_dl == {
        "type": "command_intent",
        "action": "download_action",
        "params": {"operation": "open_panel"},
        "raw_transcript": "abrir descargas",
        "confidence": 0.95,
    }

    lib_dl = resolve_command_intent("biblioteca de descargas", confidence=0.92)
    assert lib_dl == {
        "type": "command_intent",
        "action": "download_action",
        "params": {"operation": "open_library"},
        "raw_transcript": "biblioteca de descargas",
        "confidence": 0.92,
    }

    clear_dl = resolve_command_intent("limpiar descargas", confidence=0.97)
    assert clear_dl == {
        "type": "command_intent",
        "action": "download_action",
        "params": {"operation": "clear"},
        "raw_transcript": "limpiar descargas",
        "confidence": 0.97,
    }







