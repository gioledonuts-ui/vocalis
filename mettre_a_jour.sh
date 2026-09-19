#!/usr/bin/env bash
# ============================================================
#  VOCALIS - Mise à jour locale (macOS / Linux)
#  Le dépôt est PRIVÉ : la mise à jour passe par ton git.
#  Usage : ./mettre_a_jour.sh
# ============================================================
set -euo pipefail

BRANCHE="arena/01a0b9bb-vocalis"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET_DIR="${1:-$SCRIPT_DIR}"

echo ""
echo "  VOCALIS - mise à jour"
echo "  Dossier : $TARGET_DIR"
echo ""

if [ ! -d "$TARGET_DIR/.git" ]; then
  echo "  Ce dossier n'est pas un clone git."
  echo "  Le dépôt étant privé, fais un clone unique :"
  echo ""
  echo "    git clone https://github.com/gioledonuts-ui/vocalis.git"
  echo ""
  exit 1
fi

command -v git >/dev/null || { echo "  [ERREUR] git introuvable."; exit 1; }

echo "  Récupération de la dernière version (via ton git)..."
git -C "$TARGET_DIR" fetch --quiet origin "$BRANCHE"
echo "  Mise à jour des fichiers..."
git -C "$TARGET_DIR" reset --hard FETCH_HEAD

echo ""
echo "  ✔ Mise à jour terminée."
echo "  Ouvre chrome://extensions et clique sur « Actualiser » pour Vocalis."
echo ""
