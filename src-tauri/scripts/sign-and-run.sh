#!/bin/sh
# Signe le binaire `alfred` avec « Alfred Dev » s'il est disponible, puis l'exécute.
# Sans cette identité stable, chaque build ad hoc redemande l'accès au trousseau.
bin="$1"
if [ "$(basename "$bin")" = "alfred" ] && security find-certificate -c "Alfred Dev" >/dev/null 2>&1; then
  codesign -f -s "Alfred Dev" -i app.alfred.desktop "$bin" 2>/dev/null || echo "sign-and-run: signature « Alfred Dev » impossible, binaire ad hoc" >&2
fi
exec "$@"
