@echo off
setlocal

echo ============================================================
echo   ZenKev - Runner de Pruebas Locales (Upstream-Ready)
echo ============================================================

REM 1. Comprobar binario del motor Rust
set "ENGINE_EXE=%~dp0modules\voice-engine\target\release\zen-voice-engine.exe"
if not exist "%ENGINE_EXE%" (
    set "ENGINE_EXE=%~dp0modules\voice-engine\target\debug\zen-voice-engine.exe"
)

if exist "%ENGINE_EXE%" (
    echo [*] Motor Rust encontrado en: %ENGINE_EXE%
) else (
    echo [!] Aviso: No se encontro binario compilado de zen-voice-engine.exe.
    echo     Para compilarlo: cd modules\voice-engine ^&^& cargo build --release
)

REM 2. Ubicar ejecutable de Zen Browser instalado
set "ZEN_PATH="
if exist "D:\Programs\ZenBrowser\zen.exe" set "ZEN_PATH=D:\Programs\ZenBrowser\zen.exe"
if exist "%LOCALAPPDATA%\Zen Browser\zen.exe" set "ZEN_PATH=%LOCALAPPDATA%\Zen Browser\zen.exe"
if exist "%PROGRAMFILES%\Zen Browser\zen.exe" set "ZEN_PATH=%PROGRAMFILES%\Zen Browser\zen.exe"
if exist "C:\Program Files\Zen Browser\zen.exe" set "ZEN_PATH=C:\Program Files\Zen Browser\zen.exe"

if "%ZEN_PATH%"=="" (
    echo [?] Zen Browser no fue detectado en las rutas estandar.
    echo     Por favor ingresa la ruta a zen.exe o presiona Enter para salir.
    set /p "ZEN_PATH=Ruta: "
)

if "%ZEN_PATH%"=="" goto end

REM 3. Crear perfil de prueba aislado
set "DEV_PROFILE=%TEMP%\zenkev-test-profile"
if not exist "%DEV_PROFILE%" mkdir "%DEV_PROFILE%"

echo [*] Usando perfil aislado temporal: %DEV_PROFILE%
echo [*] Iniciando Zen Browser con soporte de depuracion...

start "" "%ZEN_PATH%" -profile "%DEV_PROFILE%" -jsconsole "file:///%~dp0test-page.html"

:end
endlocal
