@echo off
setlocal enabledelayedexpansion

title zenKev - Asistente de Pruebas Beta (Zen Browser)
color 0b

echo ============================================================
echo   zenKev Voice Navigator - Entorno de Pruebas Beta
echo   (Navegacion Local y Accesible por Voz para Zen Browser)
echo ============================================================
echo.

REM 1. Deteccion de Python funcional
set "PYTHON_EXE="
python -c "exit(0)" >nul 2>&1
if !ERRORLEVEL! EQU 0 set "PYTHON_EXE=python"
if "!PYTHON_EXE!"=="" (
    py -3 -c "exit(0)" >nul 2>&1
    if !ERRORLEVEL! EQU 0 set "PYTHON_EXE=py -3"
)
if "!PYTHON_EXE!"=="" (
    for /d %%P in ("%LOCALAPPDATA%\Programs\Python\Python3*") do if exist "%%~fP\python.exe" set "PYTHON_EXE="%%~fP\python.exe""
    for /d %%P in ("C:\Python3*") do if exist "%%~fP\python.exe" set "PYTHON_EXE="%%~fP\python.exe""
    for /d %%P in ("%PROGRAMFILES%\Python3*") do if exist "%%~fP\python.exe" set "PYTHON_EXE="%%~fP\python.exe""
)
if "!PYTHON_EXE!"=="" (
    for /d %%U in ("C:\Users\*") do (
        for /d %%P in ("%%~fU\AppData\Local\Programs\Python\Python3*") do if exist "%%~fP\python.exe" set "PYTHON_EXE="%%~fP\python.exe""
    )
)

REM 2. Deteccion automatica de Zen Browser
set "ZEN_BIN="

REM 2.1 Intentar deteccion inteligente profunda con Python
if exist "%~dp0scripts\detect_zen.py" if "!PYTHON_EXE!" NEQ "" (
    set "DETECT_OUT=%TEMP%\zen_detect_%RANDOM%.txt"
    !PYTHON_EXE! "%~dp0scripts\detect_zen.py" > "!DETECT_OUT!" 2>nul
    if exist "!DETECT_OUT!" (
        for /f "usebackq delims=" %%A in ("!DETECT_OUT!") do (
            if exist "%%A" set "ZEN_BIN=%%A"
        )
        del "!DETECT_OUT!" >nul 2>&1
    )
)

REM 2.2 Rutas fijas tradicionales de respaldo
if "!ZEN_BIN!"=="" (
    if exist "D:\Programs\ZenBrowser\zen.exe" set "ZEN_BIN=D:\Programs\ZenBrowser\zen.exe"
    if exist "%LOCALAPPDATA%\Zen Browser\zen.exe" set "ZEN_BIN=%LOCALAPPDATA%\Zen Browser\zen.exe"
    if exist "%PROGRAMFILES%\Zen Browser\zen.exe" set "ZEN_BIN=%PROGRAMFILES%\Zen Browser\zen.exe"
    if exist "C:\Program Files\Zen Browser\zen.exe" set "ZEN_BIN=C:\Program Files\Zen Browser\zen.exe"
    if exist "%ProgramFiles(x86)%\Zen Browser\zen.exe" set "ZEN_BIN=%ProgramFiles(x86)%\Zen Browser\zen.exe"
    if exist "%USERPROFILE%\Desktop\zen\Zen Browser\zen.exe" set "ZEN_BIN=%USERPROFILE%\Desktop\zen\Zen Browser\zen.exe"
    if exist "%USERPROFILE%\Desktop\Zen Browser\zen.exe" set "ZEN_BIN=%USERPROFILE%\Desktop\Zen Browser\zen.exe"
)

if "!ZEN_BIN!"=="" (
    echo [!] No pudimos encontrar Zen Browser en las rutas habituales.
    echo     Por favor ingresa o arrastra la ruta completa a tu zen.exe:
    set /p "ZEN_BIN=> "
)

REM Limpiar comillas si el usuario arrastro el archivo con comillas
set "ZEN_BIN=!ZEN_BIN:"=!"

if "!ZEN_BIN!"=="" (
    echo [ERROR] No se indico una ruta valida a Zen Browser. Saliendo...
    pause
    exit /b 1
)

for %%I in ("!ZEN_BIN!") do set "ZEN_DIR=%%~dpI"
if "!ZEN_DIR:~-1!"=="\" set "ZEN_DIR=!ZEN_DIR:~0,-1!"

echo [*] Zen Browser detectado en: !ZEN_BIN!
echo.

REM 2. Comprobar / Copiar el motor nativo zen-voice-engine.exe
set "LOCAL_ENGINE=%~dp0modules\voice-engine\target\release\zen-voice-engine.exe"
if not exist "!LOCAL_ENGINE!" (
    set "LOCAL_ENGINE=%~dp0modules\voice-engine\target\debug\zen-voice-engine.exe"
)

if exist "!LOCAL_ENGINE!" (
    if not exist "!ZEN_DIR!\zen-voice-engine.exe" (
        echo [*] Copiando motor de voz de baja latencia a la carpeta de Zen Browser...
        copy /y "!LOCAL_ENGINE!" "!ZEN_DIR!\zen-voice-engine.exe" >nul
    )
    REM Copiar tambien a los perfiles de usuario para resolucion directa
    for /d %%D in ("%APPDATA%\zen\Profiles\*") do (
        copy /y "!LOCAL_ENGINE!" "%%D\zen-voice-engine.exe" >nul 2>&1
        copy /y "%~dp0zen_live_mic.py" "%%D\zen_live_mic.py" >nul 2>&1
    )
)
copy /y "%~dp0zen_live_mic.py" "!ZEN_DIR!\zen_live_mic.py" >nul

REM 2.5. Verificar e instalar dependencias de microfono/audio de forma automatica
if "!PYTHON_EXE!" NEQ "" (
    !PYTHON_EXE! -c "import sounddevice, numpy, speech_recognition" >nul 2>&1
    if !ERRORLEVEL! NEQ 0 (
        echo [*] Instalando dependencias de audio de Python: sounddevice, numpy, SpeechRecognition...
        !PYTHON_EXE! -m pip install --quiet sounddevice numpy SpeechRecognition >nul 2>&1
    )
)

REM 3. Iniciar el servidor local de inferencia Kev-4B v6 si no esta corriendo
echo [*] Verificando servidor de inferencia Kev-4B v6 (puerto 8080)...
powershell -NoProfile -Command "try { $r = Invoke-RestMethod -Uri 'http://127.0.0.1:8080/health' -TimeoutSec 2; exit 0 } catch { exit 1 }" >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo [*] Iniciando servidor puente de inferencia: scripts\serve_zenkev_bridge.py...
    if "!PYTHON_EXE!" NEQ "" (
        start "zenKev Inference Bridge" /min !PYTHON_EXE! "%~dp0scripts\serve_zenkev_bridge.py"
    ) else (
        start "zenKev Inference Bridge" /min python "%~dp0scripts\serve_zenkev_bridge.py"
    )
    ping -n 4 127.0.0.1 >nul
) else (
    echo [OK] Servidor de inferencia activo y respondiendo en http://127.0.0.1:8080.
)

REM 4. Lanzar Zen Browser con la pagina de prueba
echo.
echo ============================================================
echo   INSTRUCCIONES PARA PROBAR DENTRO DE ZEN BROWSER:
echo   1. En cualquier momento presiona [Alt + V] en Zen Browser
echo      para abrir el panel flotante 'zenKev Control' (Glassy UI).
echo   2. Presiona [F2] para mostrar los badges numericos de AOM.
echo ============================================================
echo.

REM Limpiar instancias previas colgadas y locks huerfanos del perfil de Gecko
taskkill /f /im zen.exe >nul 2>&1
for /d %%D in ("%APPDATA%\zen\Profiles\*") do (
    if exist "%%D\parent.lock" del /f /q "%%D\parent.lock" >nul 2>&1
    (
        echo // zenKev Voice Navigation Preferences
        echo user_pref^("zen.voicenav.enabled", true^);
        echo user_pref^("zen.voicenav.mode", "both"^);
        echo user_pref^("zen.voicenav.debug", true^);
        echo user_pref^("zen.voicenav.earcons", true^);
    ) >> "%%D\user.js"
)

REM Parchear omni.ja si es necesario para asegurar modulos actualizados
if exist "%~dp0scripts\patch_omni.py" if "!PYTHON_EXE!" NEQ "" (
    !PYTHON_EXE! "%~dp0scripts\patch_omni.py" patch "!ZEN_DIR!" >nul 2>&1
)

set "TEST_URL=%~dp0test-page.html"
set "TEST_URL=!TEST_URL:\=/!"

echo [*] Configurando variables de entorno para motor de voz...
if exist "!LOCAL_ENGINE!" (
    set "ZEN_VOICE_ENGINE_BIN=!LOCAL_ENGINE!"
) else if exist "!ZEN_DIR!\zen-voice-engine.exe" (
    set "ZEN_VOICE_ENGINE_BIN=!ZEN_DIR!\zen-voice-engine.exe"
)
set "ZEN_VOICE_KEV_ENDPOINT=http://127.0.0.1:8080/choice"
set "ZEN_VOICE_PIPE_NAME=\\.\pipe\zen_voice_ipc"

echo [*] Abriendo Zen Browser (limpiando cache de arranque con -purgecaches)...
start "" "!ZEN_BIN!" -purgecaches "file:///!TEST_URL!"

REM 5. Ofrecer iniciar el microfono en vivo
echo.
set /p "START_MIC=[?] Deseas activar la escucha en vivo desde tu microfono fisico ahora? (S/N): "
if /i "!START_MIC!"=="S" (
    echo [*] Iniciando captura de microfono manos libres...
    if "!PYTHON_EXE!" NEQ "" (
        !PYTHON_EXE! "%~dp0zen_live_mic.py"
    ) else (
        python "%~dp0zen_live_mic.py"
    )
) else (
    echo [*] Puedes iniciar el microfono en cualquier momento ejecutando: python zen_live_mic.py
    echo [OK] Entorno de prueba listo.
    pause
)
