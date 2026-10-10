#!/usr/bin/env python3
"""
patch_omni.py - Utility to inject or restore zenKev modules in Zen Browser's omni.ja.
"""

import sys
import os
import shutil
import zipfile

ACTORS_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "modules", "voice-nav", "actors")

TARGET_ACTORS = {
    "actors/ZenVoiceNavParent.sys.mjs": os.path.join(ACTORS_DIR, "ZenVoiceNavParent.sys.mjs"),
    "actors/ZenVoiceEngineClient.sys.mjs": os.path.join(ACTORS_DIR, "ZenVoiceEngineClient.sys.mjs"),
    "actors/ZenVoiceEarconsData.sys.mjs": os.path.join(ACTORS_DIR, "ZenVoiceEarconsData.sys.mjs"),
}

def patch_omni(browser_dir):
    omni_path = os.path.join(browser_dir, "omni.ja")
    backup_path = os.path.join(browser_dir, "omni.ja.original.bak")
    temp_path = os.path.join(browser_dir, "omni.ja.patch.tmp")

    if not os.path.isfile(omni_path):
        print(f"[ERROR] omni.ja not found in {browser_dir}")
        return False

    # Create safety backup if not already present
    if not os.path.isfile(backup_path):
        print(f"[*] Creating clean backup of omni.ja -> {backup_path}")
        shutil.copy2(omni_path, backup_path)

    # Read actor payloads
    payloads = {}
    for entry_name, src_path in TARGET_ACTORS.items():
        if os.path.isfile(src_path):
            with open(src_path, "rb") as f:
                payloads[entry_name] = f.read()
        else:
            print(f"[WARNING] Local actor not found: {src_path}")

    print(f"[*] Repackaging {omni_path} with {len(payloads)} zenKev actor(s)...")
    try:
        with zipfile.ZipFile(omni_path, "r") as zin:
            with zipfile.ZipFile(temp_path, "w", compression=zipfile.ZIP_DEFLATED) as zout:
                for item in zin.infolist():
                    if item.filename in payloads:
                        zout.writestr(item, payloads[item.filename])
                    else:
                        zout.writestr(item, zin.read(item.filename))

                # Inject any actor not originally in the archive
                existing_names = set(zin.namelist())
                for entry_name, data in payloads.items():
                    if entry_name not in existing_names:
                        zout.writestr(entry_name, data)

        # Atomic replacement
        if os.path.isfile(omni_path):
            os.remove(omni_path)
        os.rename(temp_path, omni_path)
        print("[OK] omni.ja patched successfully.")
        return True
    except Exception as e:
        print(f"[ERROR] Failed to patch omni.ja: {e}")
        if os.path.isfile(temp_path):
            try:
                os.remove(temp_path)
            except Exception:
                pass
        return False

def restore_omni(browser_dir):
    omni_path = os.path.join(browser_dir, "omni.ja")
    backup_path = os.path.join(browser_dir, "omni.ja.original.bak")

    if not os.path.isfile(backup_path):
        print("[!] No original backup found to restore.")
        return False

    print(f"[*] Restoring original omni.ja from {backup_path}...")
    try:
        shutil.copy2(backup_path, omni_path)
        print("[OK] Original omni.ja restored successfully.")
        return True
    except Exception as e:
        print(f"[ERROR] Failed to restore backup: {e}")
        return False

if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("Usage: python patch_omni.py <patch|restore> <path_to_zen_browser_dir>")
        sys.exit(1)

    action = sys.argv[1].lower()
    b_dir = sys.argv[2]

    # If user gave the root Zen Browser folder, point to browser/ subdirectory
    if os.path.isdir(os.path.join(b_dir, "browser")):
        b_dir = os.path.join(b_dir, "browser")

    if action == "patch":
        success = patch_omni(b_dir)
        sys.exit(0 if success else 1)
    elif action == "restore":
        success = restore_omni(b_dir)
        sys.exit(0 if success else 1)
    else:
        print(f"[ERROR] Unknown action: {action}")
        sys.exit(1)
