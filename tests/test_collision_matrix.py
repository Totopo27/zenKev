"""
Matriz exhaustiva de pruebas de colisión y especificidad para intent_resolver.py.
Aplica TDD para garantizar que comandos compuestos o con modificadores
no sean capturados erróneamente por reglas genéricas más amplias.
"""

import pytest
from intent_resolver import resolve_command_intent

COLLISION_TEST_CASES = [
    # --- Colisiones Ventana vs Descargas ---
    ("cerrar ventana de descargas", "download_action", {"operation": "close"}),
    ("abrir ventana de descargas", "download_action", {"operation": "open_library"}),
    ("cerrar panel de descargas", "download_action", {"operation": "close"}),
    ("cerrar descargas", "download_action", {"operation": "close"}),
    ("ocultar descargas", "download_action", {"operation": "close"}),
    ("abrir descargas", "download_action", {"operation": "open_panel"}),
    ("mostrar descargas", "download_action", {"operation": "open_panel"}),
    ("ver descargas", "download_action", {"operation": "open_panel"}),
    ("panel de descargas", "download_action", {"operation": "open_panel"}),
    ("biblioteca de descargas", "download_action", {"operation": "open_library"}),
    ("gestor de descargas", "download_action", {"operation": "open_library"}),
    ("limpiar descargas", "download_action", {"operation": "clear"},),
    ("vaciar descargas", "download_action", {"operation": "clear"}),

    # --- Colisiones Ventana vs Marcadores ---
    ("cerrar ventana de marcadores", "bookmark_action", {"operation": "close"}),
    ("abrir ventana de marcadores", "bookmark_action", {"operation": "library"}),
    ("cerrar panel de marcadores", "bookmark_action", {"operation": "close"}),
    ("cerrar marcadores", "bookmark_action", {"operation": "close"}),
    ("ocultar marcadores", "bookmark_action", {"operation": "close"}),
    ("guardar en marcadores", "bookmark_action", {"operation": "save"}),
    ("marcar esta página", "bookmark_action", {"operation": "save"}),
    ("añadir a marcadores", "bookmark_action", {"operation": "save"}),
    ("eliminar marcador", "bookmark_action", {"operation": "remove"}),
    ("quitar marcador", "bookmark_action", {"operation": "remove"}),
    ("barra lateral de marcadores", "bookmark_action", {"operation": "toggle_sidebar"}),
    ("abrir marcadores", "bookmark_action", {"operation": "toggle_sidebar"}),
    ("biblioteca de marcadores", "bookmark_action", {"operation": "library"}),
    ("barra de marcadores", "bookmark_action", {"operation": "toggle_toolbar"}),

    # --- Acciones de Ventana Puras (No deben colisionar con pestañas ni paneles) ---
    ("cerrar ventana", "window_action", {"operation": "close"}),
    ("cerrar esta ventana", "window_action", {"operation": "close"}),
    ("nueva ventana", "window_action", {"operation": "new"}),
    ("abrir ventana", "window_action", {"operation": "new"}),
    ("ventana privada", "window_action", {"operation": "new_private"}),
    ("nueva ventana privada", "window_action", {"operation": "new_private"}),
    ("modo incógnito", "window_action", {"operation": "new_private"}),
    ("minimizar ventana", "window_action", {"operation": "minimize"}),
    ("maximizar ventana", "window_action", {"operation": "maximize"}),

    # --- Acciones de Pestañas (No deben colisionar con ventana) ---
    ("cerrar pestaña", "tab_action", {"operation": "close"}),
    ("cierra pestaña", "tab_action", {"operation": "close"}),
    ("nueva pestaña", "tab_action", {"operation": "new"}),
    ("abrir pestaña", "tab_action", {"operation": "new"}),
    ("siguiente pestaña", "tab_action", {"operation": "next"}),
    ("próxima pestaña", "tab_action", {"operation": "next"}),
    ("anterior pestaña", "tab_action", {"operation": "prev"}),
    ("previa pestaña", "tab_action", {"operation": "prev"}),
    ("fijar pestaña", "tab_action", {"operation": "pin"}),
    ("anclar pestaña", "tab_action", {"operation": "pin"}),
    ("desfijar pestaña", "tab_action", {"operation": "unpin"}),
    ("desanclar pestaña", "tab_action", {"operation": "unpin"}),
    ("duplicar pestaña", "tab_action", {"operation": "duplicate"}),
    ("clonar pestaña", "tab_action", {"operation": "duplicate"}),
    ("silenciar pestaña", "tab_action", {"operation": "toggle_mute"}),
    ("mutear pestaña", "tab_action", {"operation": "toggle_mute"}),
    ("ir a pestaña nueva", "tab_action", {"operation": "new"}),
    ("abrir pestaña de descargas", "tab_action", {"operation": "new", "url": "about:downloads"}),
    ("ir a pestaña de descargas", "tab_action", {"operation": "switch", "target": "descargas"}),
    ("cerrar pestaña de descargas", "tab_action", {"operation": "close", "target": "descargas"}),
    ("ir a pestaña de youtube", "tab_action", {"operation": "switch", "target": "youtube"}),
    ("cerrar pestaña de youtube", "tab_action", {"operation": "close", "target": "youtube"}),
    ("cierra pestaña youtube", "tab_action", {"operation": "close", "target": "youtube"}),
    ("cerrar pestaña esta", "tab_action", {"operation": "close"}),
    ("cierra pestaña actual", "tab_action", {"operation": "close"}),
    ("ventana de marcadores", "bookmark_action", {"operation": "library"}),
    ("ir a ventana de marcadores", "bookmark_action", {"operation": "library"}),
    ("ventana de descargas", "download_action", {"operation": "open_library"}),
    ("ir a ventana de descargas", "download_action", {"operation": "open_library"}),

    # --- Historial vs Navegación ---
    ("abrir ventana de historial", "history_action", {"operation": "open_library"}),
    ("cerrar ventana de historial", "history_action", {"operation": "close"}),
    ("abrir historial", "history_action", {"operation": "open_panel"}),
    ("panel de historial", "history_action", {"operation": "open_panel"}),
    ("cerrar historial", "history_action", {"operation": "close"}),
    ("ir atrás", "history_action", {"operation": "back"}),
    ("volver", "history_action", {"operation": "back"}),
    ("retroceder", "history_action", {"operation": "back"}),
    ("página anterior", "history_action", {"operation": "back"}),
    ("ir adelante", "history_action", {"operation": "forward"}),
    ("avanzar", "history_action", {"operation": "forward"}),
    ("página siguiente", "history_action", {"operation": "forward"}),
    ("recargar página", "history_action", {"operation": "reload"}),
    ("actualizar página", "history_action", {"operation": "reload"}),
    ("refrescar", "history_action", {"operation": "reload"}),

    # --- Zoom vs Badges / Scroll ---
    ("zoom más", "zoom_action", {"operation": "in"}),
    ("aumentar zoom", "zoom_action", {"operation": "in"}),
    ("zoom menos", "zoom_action", {"operation": "out"}),
    ("reducir zoom", "zoom_action", {"operation": "out"}),
    ("zoom 100", "zoom_action", {"operation": "reset"}),
    ("restablecer zoom", "zoom_action", {"operation": "reset"}),
    ("zoom normal", "zoom_action", {"operation": "reset"}),

    # --- Scroll ---
    ("baja", "scroll", {"direction": "down", "amount": 300}),
    ("baja un poco", "scroll", {"direction": "down", "amount": 300}),
    ("scroll abajo", "scroll", {"direction": "down", "amount": 300}),
    ("sube", "scroll", {"direction": "up", "amount": 300}),
    ("sube un poco", "scroll", {"direction": "up", "amount": 300}),
    ("scroll arriba", "scroll", {"direction": "up", "amount": 300}),

    # --- Badges Numéricos ---
    ("clic 1", "click_badge", {"badge_index": 1}),
    ("clic en el 4", "click_badge", {"badge_index": 4}),
    ("seleccionar 7", "click_badge", {"badge_index": 7}),
    ("opción 2", "click_badge", {"badge_index": 2}),
    ("badge 9", "click_badge", {"badge_index": 9}),

    # --- Pantalla Completa ---
    ("pantalla completa", "fullscreen_action", {"operation": "toggle"}),

    # --- Estado de Voz ---
    ("silenciar voz", "voice_state", {"state": "muted"}),
    ("pausar voz", "voice_state", {"state": "muted"}),
    ("activar voz", "voice_state", {"state": "active"}),
    ("desmutear voz", "voice_state", {"state": "active"}),
]


@pytest.mark.parametrize("phrase,expected_action,expected_params", COLLISION_TEST_CASES)
def test_command_intent_collision_matrix(phrase, expected_action, expected_params):
    intent = resolve_command_intent(phrase)
    assert intent is not None, f"La frase '{phrase}' no fue reconocida por ningún intent."
    assert intent["action"] == expected_action, (
        f"Colisión detectada para '{phrase}': se esperaba '{expected_action}', pero devolvió '{intent['action']}'."
    )
    for param_key, param_val in expected_params.items():
        assert intent["params"].get(param_key) == param_val, (
            f"Parámetro incorrecto para '{phrase}': {param_key}={intent['params'].get(param_key)} != {param_val}"
        )
