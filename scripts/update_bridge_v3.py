import re

# Actualizar ruta de modelo de v2 a v3 en el puente HTTP
with open("scripts/serve_zenkev_bridge.py", "r", encoding="utf-8") as f:
    code = f.read()

code_updated = code.replace('/mnt/d/Zen/runs/zenkev-v2', '/mnt/d/Zen/runs/zenkev-v3')
code_updated = code_updated.replace('Kev-4B v2', 'Kev-4B v3')
code_updated = code_updated.replace('"model":"zenkev-v2"', '"model":"zenkev-v3"')

with open("scripts/serve_zenkev_bridge.py", "w", encoding="utf-8") as f:
    f.write(code_updated)

print("Puente serve_zenkev_bridge.py actualizado a zenkev-v3 con exito.")
