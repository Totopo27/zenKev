@echo off
setlocal enabledelayedexpansion

title zenKev - Instalador Automatico para Zen Browser
color 0a

echo ============================================================
echo   zenKev Voice Navigator - Asistente de Instalacion Beta
echo   (Navegacion Local y Accesible por Voz para Zen Browser)
echo ============================================================
echo.

REM 1. Deteccion automatica de Zen Browser
set "ZEN_BIN="
if exist "D:\Programs\ZenBrowser\zen.exe" set "ZEN_BIN=D:\Programs\ZenBrowser\zen.exe"
if exist "%LOCALAPPDATA%\Zen Browser\zen.exe" set "ZEN_BIN=%LOCALAPPDATA%\Zen Browser\zen.exe"
if exist "%PROGRAMFILES%\Zen Browser\zen.exe" set "ZEN_BIN=%PROGRAMFILES%\Zen Browser\zen.exe"
if exist "C:\Program Files\Zen Browser\zen.exe" set "ZEN_BIN=C:\Program Files\Zen Browser\zen.exe"
if exist "%ProgramFiles(x86)%\Zen Browser\zen.exe" set "ZEN_BIN=%ProgramFiles(x86)%\Zen Browser\zen.exe"

if "!ZEN_BIN!"=="" (
    echo [!] No encontramos Zen Browser en las rutas tipicas.
    echo     Por favor ingresa o arrastra la ruta completa a tu zen.exe:
    set /p "ZEN_BIN=> "
)

if "!ZEN_BIN!"=="" (
    echo [ERROR] No se indico una ruta valida a Zen Browser. Abortando...
    pause
    exit /b 1
)

for %%I in ("!ZEN_BIN!") do set "ZEN_DIR=%%~dpI"
echo [OK] Zen Browser detectado en: !ZEN_BIN!
echo.

REM 2. Verificar instalacion de Python
where.exe python >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] Python no esta instalado o no se encuentra en el PATH.
    echo         Por favor descarga e instala Python 3.10+ desde https://www.python.org/
    echo         (Asegurate de marcar la casilla "Add python.exe to PATH").
    echo.
    pause
    exit /b 1
)
echo [OK] Python detectado en el sistema.

REM 3. Verificar dependencias de audio de Python (sounddevice, numpy, speech_recognition)
echo [*] Verificando librerias de audio...
python -c "import sounddevice, numpy, speech_recognition" >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo [*] Instalando dependencias requeridas (sounddevice, numpy, SpeechRecognition)...
    pip install --quiet sounddevice numpy SpeechRecognition
    if %ERRORLEVEL% NEQ 0 (
        echo [ERROR] Fallo la instalacion de dependencias con pip.
        pause
        exit /b 1
    )
    echo [OK] Dependencias instaladas correctamente.
) else (
    echo [OK] Todas las dependencias de audio estan listas.
)
echo.

REM 4. Cerrar instancias previas de Zen Browser para liberar archivos
echo [*] Cerrando instancias de Zen Browser en ejecucion...
taskkill /f /im zen.exe >nul 2>&1
for /d %%D in ("%APPDATA%\zen\Profiles\*") do (
    if exist "%%D\parent.lock" del /f /q "%%D\parent.lock" >nul 2>&1
)

REM 5. Copiar binarios y scripts al directorio de Zen Browser
set "ENGINE_SRC=%~dp0zen-voice-engine.exe"
if not exist "!ENGINE_SRC!" set "ENGINE_SRC=%~dp0modules\voice-engine\target\release\zen-voice-engine.exe"
if not exist "!ENGINE_SRC!" set "ENGINE_SRC=%~dp0modules\voice-engine\target\debug\zen-voice-engine.exe"

if exist "!ENGINE_SRC!" (
    echo [*] Copiando motor zen-voice-engine.exe a la carpeta de Zen Browser...
    copy /y "!ENGINE_SRC!" "!ZEN_DIR!zen-voice-engine.exe" >nul
) else (
    echo [!] Aviso: zen-voice-engine.exe no encontrado en el paquete.
)

copy /y "%~dp0zen_live_mic.py" "!ZEN_DIR!zen_live_mic.py" >nul
echo [OK] Archivos de audio y motor sincronizados.
echo.

REM 6. Parchear omni.ja con los modulos de voz de zenKev
echo [*] Parcheando modulos del navegador (omni.ja)...
python "%~dp0scripts\patch_omni.py" patch "!ZEN_DIR!"
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] No se pudo parchear omni.ja. Revisa permisos o si Zen Browser sigue abierto.
    pause
    exit /b 1
)
echo.

echo ============================================================
echo   INSTALACION COMPLETADA CON EXITO
echo ============================================================
echo   Para probar zenKev:
echo   1. Abre Zen Browser normalmente.
echo   2. Presiona [Alt + V] en cualquier momento para hablar.
echo   3. Si deseas desinstalar y volver a fabrica, ejecuta:
echo      desinstalar_zenkev.bat
echo ============================================================
echo.

set /p "LAUNCH_NOW=[?] Deseas abrir Zen Browser ahora con la cache purgada? (S/N): "
if /i "!LAUNCH_NOW!"=="S" (
    echo [*] Abriendo Zen Browser...
    start "" "!ZEN_BIN!" -purgecaches "file:///%~dp0test-page.html"
)

echo [OK] Listo.
pause
