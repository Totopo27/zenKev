@echo off
setlocal enabledelayedexpansion

title zenKev - Desinstalador de Zen Browser
color 0c

echo ============================================================
echo   zenKev Voice Navigator - Desinstalador / Restauracion
echo ============================================================
echo.

REM 1. Deteccion automatica de Zen Browser
set "ZEN_BIN="

REM 1.1 Intentar deteccion inteligente profunda con Python
if exist "%~dp0scripts\detect_zen.py" (
    set "DETECT_OUT=%TEMP%\zen_detect_%RANDOM%.txt"
    python "%~dp0scripts\detect_zen.py" > "!DETECT_OUT!" 2>nul
    if exist "!DETECT_OUT!" (
        for /f "usebackq delims=" %%A in ("!DETECT_OUT!") do (
            if exist "%%A" set "ZEN_BIN=%%A"
        )
        del "!DETECT_OUT!" >nul 2>&1
    )
)

REM 1.2 Rutas fijas tradicionales de respaldo
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
    echo [!] Ingrese la ruta a zen.exe para restaurar:
    set /p "ZEN_BIN=> "
)

set "ZEN_BIN=!ZEN_BIN:"=!"

if "!ZEN_BIN!"=="" (
    echo [ERROR] No se indico una ruta valida. Saliendo...
    pause
    exit /b 1
)

for %%I in ("!ZEN_BIN!") do set "ZEN_DIR=%%~dpI"
if "!ZEN_DIR:~-1!"=="\" set "ZEN_DIR=!ZEN_DIR:~0,-1!"

REM 2. Cerrar instancias en ejecucion
echo [*] Cerrando Zen Browser...
taskkill /f /im zen.exe >nul 2>&1
for /d %%D in ("%APPDATA%\zen\Profiles\*") do (
    if exist "%%D\parent.lock" del /f /q "%%D\parent.lock" >nul 2>&1
)

REM 3. Restaurar omni.ja original
echo [*] Restaurando archivo original omni.ja desde el respaldo...
python "%~dp0scripts\patch_omni.py" restore "!ZEN_DIR!"
if %ERRORLEVEL% NEQ 0 (
    echo [!] Aviso: No se pudo restaurar omni.ja automaticamente o no existia respaldo previo.
)

REM 4. Limpiar archivos de zenKev en el directorio de Zen Browser
if exist "!ZEN_DIR!\zen-voice-engine.exe" del /f /q "!ZEN_DIR!\zen-voice-engine.exe" >nul 2>&1
if exist "!ZEN_DIR!\zen_live_mic.py" del /f /q "!ZEN_DIR!\zen_live_mic.py" >nul 2>&1
if exist "!ZEN_DIR!\intent_resolver.py" del /f /q "!ZEN_DIR!\intent_resolver.py" >nul 2>&1
for /d %%D in ("%APPDATA%\zen\Profiles\*") do (
    if exist "%%D\zen-voice-engine.exe" del /f /q "%%D\zen-voice-engine.exe" >nul 2>&1
    if exist "%%D\zen_live_mic.py" del /f /q "%%D\zen_live_mic.py" >nul 2>&1
    if exist "%%D\intent_resolver.py" del /f /q "%%D\intent_resolver.py" >nul 2>&1
)

echo.
echo ============================================================
echo   DESINSTALACION COMPLETADA
echo   Zen Browser ha sido restaurado a su estado original de fabrica.
echo ============================================================
echo.
pause
