"""
Tests unitarios TDD para el cliente del Bridge Kev-4B v6 (http://127.0.0.1:8080)
Seam: resolve_with_kev_bridge(transcript, fallback_fn=resolve_command_intent)
"""

import json
from unittest.mock import patch, MagicMock
from intent_resolver import resolve_command_intent
from zen_live_mic import resolve_intent_with_kev_bridge


def test_kev_bridge_returns_typed_intent_when_server_responds():
    mock_response = MagicMock()
    mock_response.status = 200
    mock_response.read.return_value = json.dumps({
        "transcript": "cierra la pestaña de youtube",
        "subsystem": "browser_tabs",
        "subsystem_conf": 0.99,
        "action": "close_tab",
        "action_conf": 0.97,
        "latency_ms": 15.0
    }).encode("utf-8")

    with patch("urllib.request.urlopen", return_value=mock_response):
        intent = resolve_intent_with_kev_bridge("cierra la pestaña de youtube")

    assert intent is not None
    assert intent["action"] == "tab_action"
    assert intent["params"]["operation"] == "close"
    assert intent["params"]["target"] == "youtube"
    assert intent["type"] == "command_intent"


def test_kev_bridge_falls_back_gracefully_when_server_is_offline():
    # Simular fallo de conexión (ConnectionRefused / URLError)
    import urllib.error
    with patch("urllib.request.urlopen", side_effect=urllib.error.URLError("Connection refused")):
        # Debe hacer fallback a resolve_command_intent sin lanzar excepción
        intent = resolve_intent_with_kev_bridge("siguiente pestaña")

    assert intent is not None
    assert intent["action"] == "tab_action"
    assert intent["params"]["operation"] == "next"
