@echo off
setlocal enabledelayedexpansion

title zenKev - Servidor Local de Inferencia Kev-4B v6
color 0e

echo ============================================================
echo   zenKev Inference Bridge - Servidor Local Kev-4B v6
echo   (TypeSafe System One / NLI Decision Engine en Puerto 8080)
echo ============================================================
echo.

REM 1. Deteccion de entorno WSL local (modo desarrollo con GPU en WSL)
wsl --status >nul 2>&1
if %ERRORLEVEL% EQU 0 (
    wsl -d Ubuntu test -f /mnt/d/Zen/kev_repo/.venv/bin/python >nul 2>&1
    if !ERRORLEVEL! EQU 0 (
        echo [*] Entorno de inferencia con aceleracion GPU detectado en WSL Ubuntu.
        echo [*] Iniciando Kev-4B v6 desde el entorno optimizado...
        echo.
        echo Presiona Ctrl+C en esta ventana para detener el servidor.
        echo ============================================================
        wsl -d Ubuntu bash -c "cd /mnt/d/Zen/kev_repo && /mnt/d/Zen/kev_repo/.venv/bin/python /mnt/d/DocumentosDiscoD/Zen/zenKev/scripts/serve_zenkev_bridge.py"
        pause
        exit /b 0
    )
)

REM 2. Entorno Windows Nativo (para beta testers)
where.exe python >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] Python no esta disponible en el PATH del sistema.
    echo         Por favor instala Python 3.11/3.12 y asegurate de marcar "Add to PATH".
    pause
    exit /b 1
)

echo [*] Verificando dependencias de Machine Learning (torch, kev, huggingface_hub)...
python -c "import torch, kev, huggingface_hub" >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo [!] Faltan dependencias de inferencia para Kev-4B.
    echo [*] Instalando dependencias de inferencia de PyTorch y Kev...
    pip install torch --index-url https://download.pytorch.org/whl/cu124
    pip install git+https://github.com/jaredpalmer/kev huggingface_hub
    if %ERRORLEVEL% NEQ 0 (
        echo [*] Intentando instalacion de PyTorch para CPU estándar...
        pip install torch git+https://github.com/jaredpalmer/kev huggingface_hub
    )
)

echo.
echo [*] Iniciando servidor puente de inferencia (scripts\serve_zenkev_bridge.py)...
echo     Si no se encuentra el modelo local, se descargara automaticamente
echo     desde Hugging Face: https://huggingface.co/Ttotopo27/zenkev-v6
echo.
echo Presiona Ctrl+C para detener el servidor.
echo ============================================================

python "%~dp0scripts\serve_zenkev_bridge.py"
pause
