#!/usr/bin/env bash
# ============================================================
#   zenKev Voice Navigator - Asistente de Instalacion Beta (macOS)
#   (Doble clic en Finder para ejecutar)
# ============================================================

cd "$(dirname "$0")" || exit 1

echo "============================================================"
echo "  zenKev Voice Navigator - Asistente de Instalacion (macOS)"
echo "  (Navegacion Local y Accesible por Voz para Zen Browser)"
echo "============================================================"
echo ""

# 1. Detectar Python 3
PYTHON_BIN=""
if command -v python3 >/dev/null 2>&1; then
    PYTHON_BIN="python3"
elif command -v python >/dev/null 2>&1; then
    PYTHON_BIN="python"
fi

if [ -z "$PYTHON_BIN" ]; then
    echo "[ERROR] Python 3 no esta instalado o no se encuentra en el PATH."
    echo "        Por favor instala Python desde https://www.python.org/ o con Homebrew: brew install python"
    echo ""
    read -n 1 -s -r -p "Presiona cualquier tecla para salir..."
    exit 1
fi
echo "[OK] Python detectado: $($PYTHON_BIN --version)"

# 2. Detectar Zen Browser en macOS
ZEN_APP=""
if [ -d "/Applications/Zen Browser.app" ]; then
    ZEN_APP="/Applications/Zen Browser.app"
elif [ -d "/Applications/Zen.app" ]; then
    ZEN_APP="/Applications/Zen.app"
elif [ -d "$HOME/Applications/Zen Browser.app" ]; then
    ZEN_APP="$HOME/Applications/Zen Browser.app"
elif [ -d "$HOME/Applications/Zen.app" ]; then
    ZEN_APP="$HOME/Applications/Zen.app"
else
    # Intento con el script de detección
    DETECTED=$($PYTHON_BIN scripts/detect_zen.py 2>/dev/null)
    if [ -n "$DETECTED" ]; then
        ZEN_APP="$DETECTED"
    fi
fi

if [ -z "$ZEN_APP" ]; then
    echo "[!] No encontramos Zen Browser en /Applications."
    echo "    Por favor arrastra la aplicacion Zen Browser.app aqui y presiona Enter:"
    read -r ZEN_APP
fi

# Limpiar comillas o espacios extras
ZEN_APP=$(echo "$ZEN_APP" | sed 's/^"//;s/"$//')

if [ ! -d "$ZEN_APP" ] && [ ! -f "$ZEN_APP" ]; then
    echo "[ERROR] No se indico una ruta valida a Zen Browser. Abortando..."
    read -n 1 -s -r -p "Presiona cualquier tecla para salir..."
    exit 1
fi

echo "[OK] Zen Browser detectado en: $ZEN_APP"
echo ""

# 3. Verificar dependencias de audio de Python
echo "[*] Verificando librerias de audio..."
$PYTHON_BIN -c "import sounddevice, numpy, speech_recognition" >/dev/null 2>&1
if [ $? -ne 0 ]; then
    echo "[*] Instalando dependencias requeridas: sounddevice, numpy, SpeechRecognition..."
    $PYTHON_BIN -m pip install --quiet sounddevice numpy SpeechRecognition
    if [ $? -ne 0 ]; then
        echo "[ERROR] Fallo la instalacion de dependencias con pip."
        read -n 1 -s -r -p "Presiona cualquier tecla para salir..."
        exit 1
    fi
    echo "[OK] Dependencias instaladas correctamente."
else
    echo "[OK] Todas las dependencias de audio estan listas."
fi
echo ""

# 4. Cerrar instancias previas de Zen Browser
echo "[*] Cerrando instancias de Zen Browser en ejecucion..."
killall "zen" >/dev/null 2>&1 || true
killall "Zen Browser" >/dev/null 2>&1 || true
killall "Zen" >/dev/null 2>&1 || true

PROFILES_DIR="$HOME/Library/Application Support/zen/Profiles"
if [ -d "$PROFILES_DIR" ]; then
    find "$PROFILES_DIR" -name "parent.lock" -delete 2>/dev/null || true
fi

# 5. Copiar binarios y scripts al perfil de Zen Browser
ENGINE_SRC=""
if [ -f "modules/voice-engine/target/release/zen-voice-engine" ]; then
    ENGINE_SRC="modules/voice-engine/target/release/zen-voice-engine"
elif [ -f "zen-voice-engine" ]; then
    ENGINE_SRC="zen-voice-engine"
fi

if [ -d "$PROFILES_DIR" ]; then
    for profile in "$PROFILES_DIR"/*; do
        if [ -d "$profile" ]; then
            cp -f "zen_live_mic.py" "$profile/zen_live_mic.py" 2>/dev/null || true
            if [ -n "$ENGINE_SRC" ]; then
                cp -f "$ENGINE_SRC" "$profile/zen-voice-engine" 2>/dev/null || true
                chmod +x "$profile/zen-voice-engine" 2>/dev/null || true
            fi
        fi
    done
fi
echo "[OK] Archivos de audio sincronizados en perfiles."
echo ""

# 6. Parchear omni.ja con los modulos de voz de zenKev
echo "[*] Parcheando modulos del navegador (omni.ja)..."
$PYTHON_BIN scripts/patch_omni.py patch "$ZEN_APP"
if [ $? -ne 0 ]; then
    echo "[ERROR] No se pudo parchear omni.ja. Revisa permisos o si Zen Browser sigue abierto."
    read -n 1 -s -r -p "Presiona cualquier tecla para salir..."
    exit 1
fi

# 7. Inyectar preferencias de voz activas en los perfiles de usuario
echo "[*] Configurando preferencias de navegacion por voz en perfiles..."
if [ -d "$PROFILES_DIR" ]; then
    for profile in "$PROFILES_DIR"/*; do
        if [ -d "$profile" ]; then
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
echo ""

echo "============================================================"
echo "  INSTALACION COMPLETADA CON EXITO"
echo "============================================================"
echo "  Para probar zenKev:"
echo "  1. Abre Zen Browser normalmente."
echo "  2. Presiona [Alt + V] en cualquier momento para hablar."
echo "  3. Si deseas desinstalar y volver a fabrica, ejecuta:"
echo "     ./desinstalar_zenkev.command"
echo "============================================================"
echo ""

read -p "[?] Deseas abrir Zen Browser ahora con la cache purgada? (S/N): " LAUNCH_NOW
if [[ "$LAUNCH_NOW" =~ ^[Ss]$ ]]; then
    echo "[*] Abriendo Zen Browser..."
    CURRENT_DIR=$(pwd)
    open -a "$ZEN_APP" --args -purgecaches "file://$CURRENT_DIR/test-page.html"
fi

echo "[OK] Listo."
