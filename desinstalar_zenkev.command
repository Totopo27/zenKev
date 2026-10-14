#!/usr/bin/env bash
# ============================================================
#   zenKev Voice Navigator - Desinstalador Oficial (macOS)
# ============================================================

cd "$(dirname "$0")" || exit 1

echo "============================================================"
echo "  zenKev Voice Navigator - Desinstalador (macOS)"
echo "  (Restaura Zen Browser exactamente a su estado de fabrica)"
echo "============================================================"
echo ""

PYTHON_BIN=""
if command -v python3 >/dev/null 2>&1; then
    PYTHON_BIN="python3"
elif command -v python >/dev/null 2>&1; then
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

if [ -z "$ZEN_APP" ]; then
    echo "[!] No encontramos Zen Browser en /Applications."
    echo "    Por favor arrastra la aplicacion Zen Browser.app aqui y presiona Enter:"
    read -r ZEN_APP
fi

ZEN_APP=$(echo "$ZEN_APP" | sed 's/^"//;s/"$//')

echo "[*] Cerrando instancias de Zen Browser..."
killall "zen" >/dev/null 2>&1 || true
killall "Zen Browser" >/dev/null 2>&1 || true
killall "Zen" >/dev/null 2>&1 || true

PROFILES_DIR="$HOME/Library/Application Support/zen/Profiles"
if [ -d "$PROFILES_DIR" ]; then
    for profile in "$PROFILES_DIR"/*; do
        if [ -d "$profile" ]; then
            rm -f "$profile/zen-voice-engine" 2>/dev/null || true
            rm -f "$profile/zen_live_mic.py" 2>/dev/null || true
            rm -f "$profile/zenkev_debug.log" 2>/dev/null || true
        fi
    done
fi

echo "[*] Restaurando archivo original omni.ja..."
if [ -n "$PYTHON_BIN" ] && [ -f "scripts/patch_omni.py" ]; then
    $PYTHON_BIN scripts/patch_omni.py restore "$ZEN_APP"
fi

echo ""
echo "============================================================"
echo "  DESINSTALACION COMPLETADA CON EXITO"
echo "  Zen Browser ha sido restaurado a su estado original."
echo "============================================================"
echo ""
read -n 1 -s -r -p "Presiona cualquier tecla para salir..."
