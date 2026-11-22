"""Callisto V0.1 — inspección en disco tras el spike de perfiles (ejecutar con la app cerrada).

1. ¿Las cookies de los perfiles están cifradas en disco (encrypted_value) o en claro (value)?
2. ¿Aparece algún dato de la sesión privada ("privado") en archivos fuera de las particiones de perfil?
"""
import os
import sqlite3
import sys

root = sys.argv[1]
user_data = os.path.join(root, "userData")

for profile in ("profile-trabajo", "profile-universidad"):
    db = os.path.join(user_data, "Partitions", profile, "Network", "Cookies")
    con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    for name, value, enc in con.execute("SELECT name, value, encrypted_value FROM cookies"):
        prefix = bytes(enc[:3]).decode("latin-1") if enc else ""
        print(f"{profile}: cookie={name} valor_en_claro={value!r} cifrado={len(enc)}B prefijo={prefix!r}")
    con.close()

needle = b"privado"
hits = []
for dirpath, _, files in os.walk(user_data):
    if os.sep + "Partitions" + os.sep in dirpath + os.sep:
        continue
    for f in files:
        p = os.path.join(dirpath, f)
        try:
            with open(p, "rb") as fh:
                data = fh.read()
        except OSError:
            continue
        if needle in data or needle.decode().encode("utf-16-le") in data:
            hits.append(os.path.relpath(p, user_data))
print("Datos privados encontrados fuera de las particiones:", hits or "ninguno")
