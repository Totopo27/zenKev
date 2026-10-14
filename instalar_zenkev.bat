@echo off
setlocal enabledelayedexpansion

title zenKev - Instalador Automatico para Zen Browser
color 0a

echo ============================================================
echo   zenKev Voice Navigator - Asistente de Instalacion Beta
echo   (Navegacion Local y Accesible por Voz para Zen Browser)
echo ============================================================
echo.

REM 0. Verificar si se ejecuto directo dentro de un ZIP sin descomprimir
if not exist "%~dp0scripts\patch_omni.py" (
    echo [ERROR] No se encuentran los scripts de instalacion.
    echo         Es probable que hayas abierto el archivo directamente desde el ZIP.
    echo         POR FAVOR EXTRAE/DESCOMPRIME todo el contenido del .zip en una carpeta
    echo         antes de ejecutar instalar_zenkev.bat.
    echo.
    pause
    exit /b 1
)

REM 1. Deteccion y verificacion de Python funcional (evita el stub vacio de WindowsApps)
set "PYTHON_EXE="

REM 1.1 Probar si 'python' en PATH es funcional y responde
python -c "exit(0)" >nul 2>&1
if !ERRORLEVEL! EQU 0 set "PYTHON_EXE=python"

REM 1.2 Probar launcher oficial de Windows 'py -3' o 'py'
if "!PYTHON_EXE!"=="" (
    py -3 -c "exit(0)" >nul 2>&1
    if !ERRORLEVEL! EQU 0 set "PYTHON_EXE=py -3"
)

REM 1.3 Buscar instalaciones directas de Python en carpetas estandar del usuario actual
if "!PYTHON_EXE!"=="" (
    for /d %%P in ("%LOCALAPPDATA%\Programs\Python\Python3*") do (
        if exist "%%~fP\python.exe" (
            "%%~fP\python.exe" -c "exit(0)" >nul 2>&1
            if !ERRORLEVEL! EQU 0 set "PYTHON_EXE="%%~fP\python.exe""
        )
    )
)

REM 1.4 Buscar en C:\Python3* y Program Files
if "!PYTHON_EXE!"=="" (
    for /d %%P in ("C:\Python3*") do (
        if exist "%%~fP\python.exe" (
            "%%~fP\python.exe" -c "exit(0)" >nul 2>&1
            if !ERRORLEVEL! EQU 0 set "PYTHON_EXE="%%~fP\python.exe""
        )
    )
)
if "!PYTHON_EXE!"=="" (
    for /d %%P in ("%PROGRAMFILES%\Python3*") do (
        if exist "%%~fP\python.exe" (
            "%%~fP\python.exe" -c "exit(0)" >nul 2>&1
            if !ERRORLEVEL! EQU 0 set "PYTHON_EXE="%%~fP\python.exe""
        )
    )
)

REM 1.5 Si se ejecuto como Administrador, buscar en las carpetas de todos los usuarios de C:\Users
if "!PYTHON_EXE!"=="" (
    for /d %%U in ("C:\Users\*") do (
        for /d %%P in ("%%~fU\AppData\Local\Programs\Python\Python3*") do (
            if exist "%%~fP\python.exe" (
                "%%~fP\python.exe" -c "exit(0)" >nul 2>&1
                if !ERRORLEVEL! EQU 0 set "PYTHON_EXE="%%~fP\python.exe""
            )
        )
    )
)

REM 1.6 Si sigue sin encontrarse, intentar instalacion automatica con winget si esta disponible
if "!PYTHON_EXE!"=="" (
    where.exe winget >nul 2>&1
    if !ERRORLEVEL! EQU 0 (
        echo ============================================================
        echo [!] Python no esta instalado en tu equipo.
        echo     - Windows solo tiene el alias vacio de Microsoft Store -
        echo ============================================================
        echo.
        echo [*] El gestor oficial de paquetes de Windows [winget] esta disponible.
        set /p "AUTO_INSTALL=[?] Deseas instalar Python 3.12 automaticamente ahora? [S/N]: "
        if /i "!AUTO_INSTALL!"=="S" (
            echo [*] Descargando e instalando Python 3.12...
            winget install --id Python.Python.3.12 --exact --accept-package-agreements --accept-source-agreements
            echo.
            echo [*] Re-verificando Python tras la instalacion...
            for /d %%P in ("%LOCALAPPDATA%\Programs\Python\Python3*") do if exist "%%~fP\python.exe" set "PYTHON_EXE="%%~fP\python.exe""
            for /d %%P in ("%PROGRAMFILES%\Python3*") do if exist "%%~fP\python.exe" set "PYTHON_EXE="%%~fP\python.exe""
            if "!PYTHON_EXE!"=="" (
                python -c "exit(0)" >nul 2>&1
                if !ERRORLEVEL! EQU 0 set "PYTHON_EXE=python"
            )
            if "!PYTHON_EXE!"=="" (
                py -3 -c "exit(0)" >nul 2>&1
                if !ERRORLEVEL! EQU 0 set "PYTHON_EXE=py -3"
            )
        )
    )
)

if "!PYTHON_EXE!"=="" (
    echo ============================================================
    echo [ERROR] No se encontro una instalacion funcional de Python.
    echo         Windows solo tiene el alias vacio de Microsoft Store.
    echo.
    echo   Para usar zenKev, instala Python 3.12 [recomendado]:
    echo   1. Descarga el instalador oficial para Windows:
    echo      https://www.python.org/ftp/python/3.12.8/python-3.12.8-amd64.exe
    echo   2. Al abrir el instalador, MARCA LA CASILLA INFERIOR:
    echo      [X] Add python.exe to PATH
    echo   3. Haz clic en Install Now.
    echo   4. Vuelve a ejecutar este instalador: instalar_zenkev.bat
    echo ============================================================
    echo.
    pause
    exit /b 1
)
echo [OK] Python detectado en el sistema: !PYTHON_EXE!
echo.

REM 2. Deteccion automatica de Zen Browser
set "ZEN_BIN="

REM 2.1 Intentar deteccion inteligente profunda con Python (acceso directo en escritorio, registro, procesos, carpetas de usuario)
if exist "%~dp0scripts\detect_zen.py" (
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
    if exist "%LOCALAPPDATA%\Zen Browser\zen.exe" set "ZEN_BIN=%LOCALAPPDATA%\Zen Browser\zen.exe"
    if exist "%PROGRAMFILES%\Zen Browser\zen.exe" set "ZEN_BIN=%PROGRAMFILES%\Zen Browser\zen.exe"
    if exist "C:\Program Files\Zen Browser\zen.exe" set "ZEN_BIN=C:\Program Files\Zen Browser\zen.exe"
    if exist "%ProgramFiles(x86)%\Zen Browser\zen.exe" set "ZEN_BIN=%ProgramFiles(x86)%\Zen Browser\zen.exe"
    if exist "D:\Programs\ZenBrowser\zen.exe" set "ZEN_BIN=D:\Programs\ZenBrowser\zen.exe"
    if exist "%USERPROFILE%\Desktop\zen\Zen Browser\zen.exe" set "ZEN_BIN=%USERPROFILE%\Desktop\zen\Zen Browser\zen.exe"
    if exist "%USERPROFILE%\Desktop\Zen Browser\zen.exe" set "ZEN_BIN=%USERPROFILE%\Desktop\Zen Browser\zen.exe"
)

if "!ZEN_BIN!"=="" (
    echo [!] No encontramos Zen Browser en las rutas tipicas.
    echo     Por favor ingresa o arrastra la ruta completa a tu zen.exe:
    set /p "ZEN_BIN=> "
)

REM Limpiar comillas si el usuario arrastro el archivo con comillas
set "ZEN_BIN=!ZEN_BIN:"=!"

if "!ZEN_BIN!"=="" (
    echo [ERROR] No se indico una ruta valida a Zen Browser. Abortando...
    pause
    exit /b 1
)

for %%I in ("!ZEN_BIN!") do set "ZEN_DIR=%%~dpI"
if "!ZEN_DIR:~-1!"=="\" set "ZEN_DIR=!ZEN_DIR:~0,-1!"
echo [OK] Zen Browser detectado en: !ZEN_BIN!
echo.

REM 3. Verificar dependencias de audio de Python (sounddevice, numpy, speech_recognition)
echo [*] Verificando librerias de audio...
!PYTHON_EXE! -c "import sounddevice, numpy, speech_recognition" >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo [*] Instalando dependencias requeridas: sounddevice, numpy, SpeechRecognition...
    !PYTHON_EXE! -m pip install --quiet sounddevice numpy SpeechRecognition
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
    copy /y "!ENGINE_SRC!" "!ZEN_DIR!\zen-voice-engine.exe" >nul
    for /d %%D in ("%APPDATA%\zen\Profiles\*") do (
        copy /y "!ENGINE_SRC!" "%%D\zen-voice-engine.exe" >nul 2>&1
        copy /y "%~dp0zen_live_mic.py" "%%D\zen_live_mic.py" >nul 2>&1
    )
) else (
    echo [!] Aviso: zen-voice-engine.exe no encontrado en el paquete.
)

copy /y "%~dp0zen_live_mic.py" "!ZEN_DIR!\zen_live_mic.py" >nul
echo [OK] Archivos de audio y motor sincronizados.
echo.

REM 6. Parchear omni.ja con los modulos de voz de zenKev
echo [*] Parcheando modulos del navegador (omni.ja)...
!PYTHON_EXE! "%~dp0scripts\patch_omni.py" patch "!ZEN_DIR!"
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] No se pudo parchear omni.ja. Revisa permisos o si Zen Browser sigue abierto.
    pause
    exit /b 1
)

REM 7. Inyectar preferencias de voz activas en los perfiles de usuario
echo [*] Configurando preferencias de navegacion por voz en perfiles de Zen Browser...
for /d %%D in ("%APPDATA%\zen\Profiles\*") do (
    (
        echo // zenKev Voice Navigation Preferences
        echo user_pref^("zen.voicenav.enabled", true^);
        echo user_pref^("zen.voicenav.mode", "both"^);
        echo user_pref^("zen.voicenav.debug", true^);
        echo user_pref^("zen.voicenav.earcons", true^);
    ) >> "%%D\user.js"
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
