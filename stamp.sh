#!/bin/sh
# Setzt eine neue Versionsnummer (Datum und Uhrzeit) in index.html und version.json.
# Vor jedem Hochladen ausführen:   ./stamp.sh
# Dann holen sich alle Geräte beim nächsten Öffnen die neuen Dateien, auch wenn GitHub noch zwischengespeichert hat.
set -e
cd "$(dirname "$0")"
B="$(date +%Y%m%d-%H%M)"
export B
perl -pi -e 's/(\.(?:js|css))\?v=[0-9-]+/$1?v=$ENV{B}/g; s/(name="build" content=")[0-9-]*/$1$ENV{B}/' index.html
printf '{"build":"%s"}\n' "$B" > version.json
echo "Version $B gesetzt (index.html, version.json)"
