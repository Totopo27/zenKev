#!/usr/bin/env python3
"""
scripts/detect_zen.py
Detecta la ubicación de zen.exe en Windows mediante múltiples métodos:
1. Acceso directo en el Escritorio (Desktop/*.lnk)
2. Registro de Windows (App Paths, Uninstall keys)
3. Búsqueda en rutas estándar y carpetas de usuario (Desktop, Downloads, LocalAppData, Program Files)
4. Procesos en ejecución (zen.exe)
"""

import os
import sys
import glob

def get_running_zen():
    try:
        import subprocess
        output = subprocess.check_output(
            ["powershell", "-NoProfile", "-Command", "Get-Process zen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Path"],
            text=True, stderr=subprocess.DEVNULL
        ).strip()
        for line in output.splitlines():
            line = line.strip().strip('"')
            if line and os.path.isfile(line) and line.lower().endswith("zen.exe"):
                return line
    except Exception:
        pass
    return None

def resolve_lnk(lnk_path):
    try:
        # Intento rápido con PowerShell para no requerir pywin32
        import subprocess
        cmd = f'(New-Object -ComObject WScript.Shell).CreateShortcut("{lnk_path}").TargetPath'
        res = subprocess.check_output(["powershell", "-NoProfile", "-Command", cmd], text=True, stderr=subprocess.DEVNULL).strip()
        if res and os.path.isfile(res) and res.lower().endswith("zen.exe"):
            return res
    except Exception:
        pass
    return None

def search_desktop():
    userprofile = os.environ.get("USERPROFILE", "")
    desktop_dirs = [
        os.path.join(userprofile, "Desktop"),
        os.path.join(os.environ.get("PUBLIC", ""), "Desktop"),
        os.path.join(userprofile, "Escritorio"),
    ]
    for d in desktop_dirs:
        if not os.path.isdir(d):
            continue
        # 1. Buscar accesos directos
        for lnk in glob.glob(os.path.join(d, "*.lnk")):
            target = resolve_lnk(lnk)
            if target:
                return target
        # 2. Buscar carpetas tipo Desktop\zen\Zen Browser\zen.exe
        for root, dirs, files in os.walk(d):
            if "zen.exe" in [f.lower() for f in files]:
                for f in files:
                    if f.lower() == "zen.exe":
                        return os.path.join(root, f)
            # Limitar profundidad
            if root.count(os.sep) - d.count(os.sep) >= 3:
                dirs.clear()
    return None

def search_registry():
    try:
        import winreg
        keys_to_check = [
            (winreg.HKEY_CURRENT_USER, r"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\zen.exe"),
            (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\zen.exe"),
            (winreg.HKEY_CURRENT_USER, r"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\Zen.exe"),
            (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\Zen.exe"),
        ]
        for hkey, subkey in keys_to_check:
            try:
                with winreg.OpenKey(hkey, subkey) as k:
                    val, _ = winreg.QueryValueEx(k, "")
                    val = val.strip().strip('"')
                    if os.path.isfile(val) and val.lower().endswith("zen.exe"):
                        return val
            except OSError:
                pass
    except Exception:
        pass
    return None

def search_common_paths():
    userprofile = os.environ.get("USERPROFILE", "")
    localappdata = os.environ.get("LOCALAPPDATA", "")
    programfiles = os.environ.get("PROGRAMFILES", "")
    programfiles_x86 = os.environ.get("ProgramFiles(x86)", "")
    
    candidates = [
        os.path.join(localappdata, "Zen Browser", "zen.exe"),
        os.path.join(programfiles, "Zen Browser", "zen.exe"),
        os.path.join(programfiles_x86, "Zen Browser", "zen.exe"),
        r"C:\Program Files\Zen Browser\zen.exe",
        r"C:\Program Files (x86)\Zen Browser\zen.exe",
        r"D:\Programs\ZenBrowser\zen.exe",
        os.path.join(userprofile, "Downloads", "zen", "zen.exe"),
        os.path.join(userprofile, "Downloads", "Zen Browser", "zen.exe"),
    ]
    for c in candidates:
        if c and os.path.isfile(c):
            return c
    return None

def find_zen_bin():
    # 0. Detección específica para macOS (Darwin)
    if sys.platform == "darwin":
        home = os.path.expanduser("~")
        mac_apps = [
            "/Applications/Zen Browser.app",
            "/Applications/Zen.app",
            os.path.join(home, "Applications", "Zen Browser.app"),
            os.path.join(home, "Applications", "Zen.app"),
        ]
        for app in mac_apps:
            if os.path.isdir(app):
                # Preferir el binario ejecutable si existe
                bin_path = os.path.join(app, "Contents", "MacOS", "zen")
                if os.path.isfile(bin_path):
                    return bin_path
                return app
        return None

    # 0.1 Detección para Linux
    if sys.platform.startswith("linux"):
        import shutil
        for name in ("zen", "zen-browser"):
            w = shutil.which(name)
            if w: return w
        home = os.path.expanduser("~")
        linux_paths = [
            "/opt/zen/zen",
            "/opt/zen-browser/zen",
            os.path.join(home, ".local", "share", "zen", "zen"),
            os.path.join(home, ".local", "bin", "zen"),
        ]
        for p in linux_paths:
            if os.path.isfile(p):
                return p
        return None

    # 1. Proceso activo (Windows)
    p = get_running_zen()
    if p: return p

    # 2. Rutas conocidas directas
    p = search_common_paths()
    if p: return p

    # 3. Acceso directo o carpetas en Escritorio (como en la captura del usuario)
    p = search_desktop()
    if p: return p

    # 4. Registro de Windows
    p = search_registry()
    if p: return p

    return None

if __name__ == "__main__":
    found = find_zen_bin()
    if found:
        print(found)
        sys.exit(0)
    else:
        sys.exit(1)
