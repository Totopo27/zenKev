#!/usr/bin/env bash
# ============================================================
#   zenKev - Entorno de Prueba Rápida Beta (macOS)
# ============================================================

cd "$(dirname "$0")" || exit 1

echo "============================================================"
echo "  zenKev Voice Navigator - Entorno de Prueba (macOS)"
echo "============================================================"
echo ""

PYTHON_BIN="python3"
if ! command -v python3 >/dev/null 2>&1; then
    PYTHON_BIN="python"
fi

ZEN_APP=""
if [ -d "/Applications/Zen Browser.app" ]; then
    ZEN_APP="/Applications/Zen Browser.app"
elif [ -d "/Applications/Zen.app" ]; then
    ZEN_APP="/Applications/Zen.app"
elif [ -d "$HOME/Applications/Zen Browser.app" ]; then
    ZEN_APP="$HOME/Applications/Zen Browser.app"
elif [ -d "$HOME/Applications/Zen.app" ]; then
    ZEN_APP="$HOME/Applications/Zen.app"
fi

# 1. Copiar y sincronizar con los perfiles
PROFILES_DIR="$HOME/Library/Application Support/zen/Profiles"
if [ -d "$PROFILES_DIR" ]; then
    for profile in "$PROFILES_DIR"/*; do
        if [ -d "$profile" ]; then
            cp -f "zen_live_mic.py" "$profile/zen_live_mic.py" 2>/dev/null || true
            cat << 'EOF' >> "$profile/user.js"
// zenKev Voice Navigation Preferences
user_pref("zen.voicenav.enabled", true);
user_pref("zen.voicenav.mode", "both");
user_pref("zen.voicenav.debug", true);
user_pref("zen.voicenav.earcons", true);
EOF
        fi
    done
fi

# 2. Verificar dependencias de audio
$PYTHON_BIN -c "import sounddevice, numpy, speech_recognition" >/dev/null 2>&1
if [ $? -ne 0 ]; then
    echo "[*] Instalando dependencias requeridas..."
    $PYTHON_BIN -m pip install --quiet sounddevice numpy SpeechRecognition
fi

# 3. Servidor de inferencia Kev-4B v6 (puerto 8080)
echo "[*] Verificando servidor de inferencia Kev-4B v6 (puerto 8080)..."
curl -s -m 2 http://127.0.0.1:8080/health >/dev/null 2>&1
if [ $? -ne 0 ]; then
    echo "[*] Iniciando servidor puente de inferencia en segundo plano..."
    $PYTHON_BIN scripts/serve_zenkev_bridge.py > /dev/null 2>&1 &
    sleep 3
else
    echo "[OK] Servidor de inferencia activo y respondiendo."
fi

# 4. Parchear si es necesario
if [ -n "$ZEN_APP" ] && [ -f "scripts/patch_omni.py" ]; then
    $PYTHON_BIN scripts/patch_omni.py patch "$ZEN_APP" >/dev/null 2>&1 || true
fi

# 5. Abrir Zen Browser con la página de pruebas
CURRENT_DIR=$(pwd)
echo "[*] Abriendo Zen Browser con pagina de pruebas..."
if [ -n "$ZEN_APP" ]; then
    open -a "$ZEN_APP" --args -purgecaches "file://$CURRENT_DIR/test-page.html"
else
    open "file://$CURRENT_DIR/test-page.html"
fi

echo ""
echo "============================================================"
echo "  INSTRUCCIONES PARA PROBAR DENTRO DE ZEN BROWSER:"
echo "  1. En cualquier momento presiona [Alt + V] en Zen Browser"
echo "     para abrir el panel flotante 'zenKev Control'."
echo "  2. Presiona [F2] para mostrar los badges numericos de AOM."
echo "============================================================"
echo ""

read -p "[?] Deseas activar la escucha en vivo desde tu microfono fisico ahora? (S/N): " START_MIC
if [[ "$START_MIC" =~ ^[Ss]$ ]]; then
    echo "[*] Iniciando captura de microfono manos libres..."
    $PYTHON_BIN zen_live_mic.py
else
    echo "[OK] Puedes iniciar el microfono en cualquier momento con: $PYTHON_BIN zen_live_mic.py"
    read -n 1 -s -r -p "Presiona cualquier tecla para finalizar..."
fi
