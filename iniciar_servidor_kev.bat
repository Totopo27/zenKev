@echo off
setlocal enabledelayedexpansion

title zenKev - Servidor Local de Inferencia Kev-4B v6
color 0e

echo ============================================================
echo   zenKev Inference Bridge - Servidor Local Kev-4B v6
echo   (TypeSafe System One / NLI Decision Engine en Puerto 8080)
echo ============================================================
echo.

REM 0. Verificar si se ejecuto directo dentro del ZIP sin descomprimir
if not exist "%~dp0scripts\serve_zenkev_bridge.py" (
    echo [ERROR] No se encuentran los scripts del servidor.
    echo         Has abierto este archivo directamente dentro del ZIP.
    echo         POR FAVOR EXTRAE/DESCOMPRIME todo el contenido del .zip en una carpeta
    echo         antes de ejecutar este archivo.
    echo.
    pause
    exit /b 1
)

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

if "!PYTHON_EXE!"=="" (
    echo ============================================================
    echo [ERROR] No se encontro una instalacion funcional de Python.
    echo         Windows solo detecto el alias vacio de Microsoft Store.
    echo.
    echo Requisitos de Python para el servidor de IA:
    echo   - Instalar Python 3.12 (recomendado):
    echo     https://www.python.org/ftp/python/3.12.8/python-3.12.8-amd64.exe
    echo   - Asegurate de marcar la casilla "Add python.exe to PATH" en el instalador.
    echo ============================================================
    echo.
    pause
    exit /b 1
)

REM Verificar version de Python (requiere 3.11, 3.12 o 3.13)
for /f "tokens=2 delims= " %%v in ('!PYTHON_EXE! --version 2^>^&1') do set "PY_VER=%%v"
echo [*] Version de Python detectada: !PY_VER!

!PYTHON_EXE! -c "import sys; sys.exit(0 if (3, 11) <= sys.version_info < (3, 14) else 1)" >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo.
    echo [ERROR] Version de Python incompatible: !PY_VER!
    echo         PyTorch y el framework Kev requieren Python 3.11, 3.12 o 3.13.
    echo         Versiones mas recientes como Python 3.14+ o 3.15 aun no tienen soporte ni binarios compilados (wheels) de PyTorch.
    echo.
    echo         Solucion: Instala Python 3.12 desde:
    echo         https://www.python.org/downloads/release/python-3.12-8/
    echo.
    pause
    exit /b 1
)

REM Verificar Git (requerido para compilar/instalar dependencias de repositorios)
where.exe git >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo.
    echo [ERROR] Git no esta instalado o no se encuentra en el PATH.
    echo         Para descargar e instalar el framework Kev es indispensable Git para Windows.
    echo.
    echo         Por favor descarga e instala Git desde:
    echo         https://git-scm.com/download/win
    echo.
    pause
    exit /b 1
)

echo [*] Verificando dependencias de Machine Learning (torch, kev, huggingface_hub)...
!PYTHON_EXE! -c "import torch, kev, huggingface_hub" >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo [!] Faltan dependencias de inferencia para Kev-4B.
    echo [*] Instalando dependencias de inferencia de PyTorch y Kev...
    !PYTHON_EXE! -m pip install torch --index-url https://download.pytorch.org/whl/cu124
    !PYTHON_EXE! -m pip install git+https://github.com/jaredpalmer/kev huggingface_hub
    if %ERRORLEVEL% NEQ 0 (
        echo [*] Intentando instalacion de PyTorch para CPU estándar...
        !PYTHON_EXE! -m pip install torch git+https://github.com/jaredpalmer/kev huggingface_hub
        if !ERRORLEVEL! NEQ 0 (
            echo.
            echo [ERROR] No se pudieron instalar las dependencias de Kev. Revisa tu conexion o permisos.
            pause
            exit /b 1
        )
    )
) else (
    REM Si torch ya esta instalado, verificar compatibilidad basica con CUDA si existe GPU
    !PYTHON_EXE! -c "import torch; exit(0 if not torch.cuda.is_available() or torch.cuda.get_device_capability()[0] <= 9 else 1)" >nul 2>&1
    if !ERRORLEVEL! NEQ 0 (
        echo [!] AVISO: GPU de arquitectura muy reciente detectada. Si experimentas errores de kernel, actualiza PyTorch con:
        echo     !PYTHON_EXE! -m pip install --upgrade --force-reinstall torch --index-url https://download.pytorch.org/whl/cu124
    )
)

echo.
echo [*] Iniciando servidor puente de inferencia (scripts\serve_zenkev_bridge.py)...
echo     Si no se encuentra el modelo local, se descargara automaticamente
echo     desde Hugging Face: https://huggingface.co/Ttotopo27/zenkev-v6
echo.
echo Presiona Ctrl+C para detener el servidor.
echo ============================================================

!PYTHON_EXE! "%~dp0scripts\serve_zenkev_bridge.py"
pause
