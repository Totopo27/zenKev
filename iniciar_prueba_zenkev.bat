@echo off
setlocal enabledelayedexpansion

title zenKev - Asistente de Pruebas Beta (Zen Browser)
color 0b

echo ============================================================
echo   zenKev Voice Navigator - Entorno de Pruebas Beta
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
    echo [!] No pudimos encontrar Zen Browser en las rutas habituales.
    echo     Por favor ingresa o arrastra la ruta completa a tu zen.exe:
    set /p "ZEN_BIN=> "
)

if "!ZEN_BIN!"=="" (
    echo [ERROR] No se indico una ruta valida a Zen Browser. Saliendo...
    pause
    exit /b 1
)

for %%I in ("!ZEN_BIN!") do set "ZEN_DIR=%%~dpI"

echo [*] Zen Browser detectado en: !ZEN_BIN!
echo.

REM 2. Comprobar / Copiar el motor nativo zen-voice-engine.exe
set "LOCAL_ENGINE=%~dp0modules\voice-engine\target\release\zen-voice-engine.exe"
if not exist "!LOCAL_ENGINE!" (
    set "LOCAL_ENGINE=%~dp0modules\voice-engine\target\debug\zen-voice-engine.exe"
)

if exist "!LOCAL_ENGINE!" (
    if not exist "!ZEN_DIR!zen-voice-engine.exe" (
        echo [*] Copiando motor de voz de baja latencia a la carpeta de Zen Browser...
        copy /y "!LOCAL_ENGINE!" "!ZEN_DIR!zen-voice-engine.exe" >nul
    )
) else (
    echo [!] Aviso: zen-voice-engine.exe no encontrado en target\.
    echo     Se utilizara el canal por defecto o IPC simulado.
)

REM 3. Iniciar el servidor local de inferencia Kev-4B v6 si no esta corriendo
echo [*] Verificando servidor de inferencia Kev-4B v6 (puerto 8080)...
powershell -NoProfile -Command "try { $r = Invoke-RestMethod -Uri 'http://127.0.0.1:8080/health' -TimeoutSec 2; exit 0 } catch { exit 1 }" >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo [*] Iniciando servidor puente de inferencia (scripts\serve_zenkev_bridge.py)...
    start "zenKev Inference Bridge" /min python "%~dp0scripts\serve_zenkev_bridge.py"
    timeout /t 3 /nobreak >nul
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

echo [*] Abriendo Zen Browser...
start "" "!ZEN_BIN!" "file:///%~dp0test-page.html"

REM 5. Ofrecer iniciar el microfono en vivo
echo.
set /p "START_MIC=[?] Deseas activar la escucha en vivo desde tu microfono fisico ahora? (S/N): "
if /i "!START_MIC!"=="S" (
    echo [*] Iniciando captura de microfono manos libres...
    python "%~dp0zen_live_mic.py"
) else (
    echo [*] Puedes iniciar el microfono en cualquier momento ejecutando: python zen_live_mic.py
    echo [OK] Entorno de prueba listo.
    pause
)
