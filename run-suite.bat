@echo off
setlocal

echo ============================================================
echo   ZenKev - Suite de Pruebas Integradas Locales
echo ============================================================

set "ROOT=%~dp0"
set "ENGINE_EXE=%ROOT%modules\voice-engine\target\release\zen-voice-engine.exe"
if not exist "%ENGINE_EXE%" set "ENGINE_EXE=%ROOT%modules\voice-engine\target\debug\zen-voice-engine.exe"

set "ZEN_PATH="
if exist "D:\Programs\ZenBrowser\zen.exe" set "ZEN_PATH=D:\Programs\ZenBrowser\zen.exe"
if exist "%LOCALAPPDATA%\Zen Browser\zen.exe" set "ZEN_PATH=%LOCALAPPDATA%\Zen Browser\zen.exe"
if exist "%PROGRAMFILES%\Zen Browser\zen.exe" set "ZEN_PATH=%PROGRAMFILES%\Zen Browser\zen.exe"

echo [*] Estado del Entorno:
if exist "%ENGINE_EXE%" (
    echo     [OK] Motor Rust: %ENGINE_EXE%
) else (
    echo     [!] Motor Rust: No compilado (usa: cd modules\voice-engine ^&^& cargo build --release)
)

if "%ZEN_PATH%"=="" (
    echo     [X] Zen Browser: No detectado
) else (
    echo     [OK] Zen Browser: %ZEN_PATH%
)

echo.
echo Selecciona el modo de prueba:
echo   [1] Lanzar Zen Browser con Perfil Aislado y Consola de Depuracion
echo   [2] Ejecutar Pruebas de Integracion IPC del Motor Rust (Node/Vitest)
echo   [3] Iniciar Microfono en Vivo (Python Live Mic)
echo   [4] Salir
echo.

set /p "CHOICE=Opcion [1-4]: "

if "%CHOICE%"=="1" (
    if "%ZEN_PATH%"=="" (
        echo Error: No se puede iniciar Zen Browser porque no se encontro zen.exe.
        pause
        goto end
    )
    set "DEV_PROFILE=%TEMP%\zenkev-test-profile"
    if not exist "%DEV_PROFILE%" mkdir "%DEV_PROFILE%"
    echo Iniciando Zen Browser con consola JS...
    start "" "%ZEN_PATH%" -profile "%DEV_PROFILE%" -jsconsole "file:///%ROOT%test-page.html"
)

if "%CHOICE%"=="2" (
    echo Ejecutando test de comunicacion IPC con el motor...
    node "%ROOT%modules\voice-engine\tests\test_live_ipc.mjs"
    pause
)

if "%CHOICE%"=="3" (
    echo Iniciando servicio de escucha continua de microfono...
    python "%ROOT%zen_live_mic.py"
)

:end
endlocal
