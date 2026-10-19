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





