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

# 1. Detectar Python 3 del sistema
PYTHON_SYS=""
for py in python3 /opt/homebrew/bin/python3 /usr/local/bin/python3 python; do
    if command -v "$py" >/dev/null 2>&1; then
        PY_MAJOR=$("$py" -c "import sys; print(sys.version_info.major)" 2>/dev/null || true)
        if [ "$PY_MAJOR" = "3" ]; then
            PYTHON_SYS="$py"
            break
        fi
    fi
done

if [ -z "$PYTHON_SYS" ]; then
    echo "[ERROR] Python 3 no esta instalado o no se encuentra en el PATH."
    echo "        Por favor instala Python 3 desde https://www.python.org/ o con Homebrew: brew install python"
    echo ""
    read -n 1 -s -r -p "Presiona cualquier tecla para salir..."
    exit 1
fi
echo "[OK] Python del sistema detectado: $($PYTHON_SYS --version)"

# 2. Configurar entorno virtual aislado (.zenkev_venv)
# Esto previene errores de Homebrew en macOS por PEP 668 (externally-managed-environment)
VENV_DIR="$(pwd)/.zenkev_venv"
if [ ! -d "$VENV_DIR" ]; then
    echo "[*] Creando entorno virtual aislado (.zenkev_venv)..."
    "$PYTHON_SYS" -m venv "$VENV_DIR" 2>/dev/null || true
fi

if [ -f "$VENV_DIR/bin/python" ]; then
    PYTHON_BIN="$VENV_DIR/bin/python"
    PIP_BIN="$VENV_DIR/bin/pip"
    echo "[OK] Entorno virtual activo en .zenkev_venv"
else
    PYTHON_BIN="$PYTHON_SYS"
    PIP_BIN="$PYTHON_SYS -m pip"
    echo "[!] Usando Python del sistema directamente."
fi
echo ""

# 3. Detectar Zen Browser en macOS
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
    DETECTED=$($PYTHON_BIN scripts/detect_zen.py 2>/dev/null || true)
    if [ -n "$DETECTED" ]; then
        ZEN_APP="$DETECTED"
    fi
fi

if [ -z "$ZEN_APP" ]; then
    echo "[!] No encontramos Zen Browser en /Applications."
    echo "    Por favor arrastra la aplicacion Zen Browser.app aqui y presiona Enter:"
    read -r ZEN_APP
fi

# Limpiar comillas y normalizar ruta al paquete .app
ZEN_APP=$(echo "$ZEN_APP" | sed 's/^"//;s/"$//')
if [[ "$ZEN_APP" == *".app"* ]]; then
    ZEN_APP="${ZEN_APP%%.app*}.app"
fi

if [ ! -d "$ZEN_APP" ]; then
    echo "[ERROR] No se indico una ruta valida a Zen Browser.app ($ZEN_APP). Abortando..."
    read -n 1 -s -r -p "Presiona cualquier tecla para salir..."
    exit 1
fi

echo "[OK] Zen Browser detectado en: $ZEN_APP"
echo ""

# 4. Verificar dependencias de audio de Python
echo "[*] Verificando librerias de audio..."
$PYTHON_BIN -c "import sounddevice, numpy, speech_recognition" >/dev/null 2>&1
if [ $? -ne 0 ]; then
    echo "[*] Instalando dependencias requeridas (sounddevice, numpy, SpeechRecognition)..."
    if [ -f "$VENV_DIR/bin/pip" ]; then
        "$VENV_DIR/bin/pip" install --quiet sounddevice numpy SpeechRecognition
    else
        $PYTHON_BIN -m pip install --quiet --break-system-packages sounddevice numpy SpeechRecognition 2>/dev/null || \
        $PYTHON_BIN -m pip install --quiet sounddevice numpy SpeechRecognition
    fi
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

# 5. Cerrar instancias previas de Zen Browser
echo "[*] Cerrando instancias de Zen Browser en ejecucion..."
killall "zen" >/dev/null 2>&1 || true
killall "Zen Browser" >/dev/null 2>&1 || true
killall "Zen" >/dev/null 2>&1 || true

PROFILES_DIR="$HOME/Library/Application Support/zen/Profiles"
if [ -d "$PROFILES_DIR" ]; then
    find "$PROFILES_DIR" -name "parent.lock" -delete 2>/dev/null || true
fi

# 6. Copiar binarios y scripts al perfil de Zen Browser
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
echo "[OK] Scripts sincronizados en perfiles."
echo ""

# 7. Parchear omni.ja con los modulos de voz de zenKev (Manejo robusto de permisos)
echo "[*] Parcheando modulos del navegador (omni.ja)..."
OMNI_FILE=""
for cand in "$ZEN_APP/Contents/Resources/browser/omni.ja" "$ZEN_APP/Contents/Resources/omni.ja" "$ZEN_APP/browser/omni.ja"; do
    if [ -f "$cand" ]; then
        OMNI_FILE="$cand"
        break
    fi
done

NEED_SUDO=0
if [ -n "$OMNI_FILE" ] && [ ! -w "$OMNI_FILE" ]; then
    NEED_SUDO=1
elif [ ! -w "$ZEN_APP" ]; then
    NEED_SUDO=1
fi

if [ $NEED_SUDO -eq 1 ]; then
    echo "[*] Se requieren permisos de administrador para modificar archivos en /Applications."
    echo "    Introduce tu contrasena de macOS si el sistema te la solicita:"
    sudo "$PYTHON_BIN" scripts/patch_omni.py patch "$ZEN_APP"
else
    "$PYTHON_BIN" scripts/patch_omni.py patch "$ZEN_APP"
fi

if [ $? -ne 0 ]; then
    echo "[ERROR] No se pudo parchear omni.ja. Revisa permisos o si Zen Browser sigue abierto."
    read -n 1 -s -r -p "Presiona cualquier tecla para salir..."
    exit 1
fi

# 8. Saneamiento de firma ad-hoc y Gatekeeper para macOS
echo "[*] Aplicando firma ad-hoc para Gatekeeper de macOS..."
if command -v codesign >/dev/null 2>&1; then
    if [ $NEED_SUDO -eq 1 ]; then
        sudo codesign --force --deep -s - "$ZEN_APP" 2>/dev/null || true
    else
        codesign --force --deep -s - "$ZEN_APP" 2>/dev/null || true
    fi
fi
xattr -d -r com.apple.quarantine "$ZEN_APP" 2>/dev/null || true

# 9. Inyectar preferencias de voz activas en los perfiles de usuario
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
echo ""
echo "  [!] AVISO CRITICO DE MICROFONO EN macOS (TCC):"
echo "  Para capturar tu voz correctamente:"
echo "  1. Ve a: Ajustes del Sistema -> Privacidad y Seguridad -> Microfono"
echo "  2. Asegurate de que 'Terminal' (o tu aplicacion de terminal)"
echo "     tenga la casilla de acceso al Microfono ACTIVADA."
echo ""
echo "  Para probar zenKev:"
echo "  - Ejecuta: ./iniciar_prueba_zenkev.command"
echo "  - O abre Zen Browser y pulsa [Alt + V] para hablar."
echo "  - Si deseas desinstalar y volver a fabrica: ./desinstalar_zenkev.command"
echo "============================================================"
echo ""

read -p "[?] Deseas abrir Zen Browser ahora con la cache purgada? (S/N): " LAUNCH_NOW
if [[ "$LAUNCH_NOW" =~ ^[Ss]$ ]]; then
    echo "[*] Abriendo Zen Browser..."
    CURRENT_DIR=$(pwd)
    open -a "$ZEN_APP" --args -purgecaches "file://$CURRENT_DIR/test-page.html"
fi

echo "[OK] Listo."
