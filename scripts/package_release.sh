#!/usr/bin/env bash
# ============================================================
#  VOCALIS - Préparation d'un zip de release GitHub
#  Usage (depuis la racine du dépôt) :
#    scripts/package_release.sh 0.2.0
#  Produit : /tmp/vocalis-v0.2.0.zip (fichiers commités uniquement)
#  Ensuite :
#    gh release create v0.2.0 /tmp/vocalis-v0.2.0.zip \
#      --title "v0.2.0" --notes "..."
# ============================================================
set -euo pipefail

VERSION="${1:?Usage : package_release.sh <version>   (ex : 0.2.0)}"
OUT="/tmp/vocalis-v${VERSION}.zip"

cd "$(git rev-parse --show-toplevel)"
git archive --format=zip --prefix=vocalis/ -o "$OUT" HEAD

echo "OK : $OUT"
echo "Contenu :"
unzip -l "$OUT" | tail -n +4 | head -n -2
