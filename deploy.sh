#!/bin/bash
# Installs or updates the plugin in Photoshop.
#
# A password is needed ONLY for the first install: /Applications/.../Plug-ins
# is owned by root, so the folder cannot be created there without sudo. The
# script then chowns it to you, and later updates need no password — so we try
# without sudo first and call it only if the write fails.
set -e

# The folder name must match the one already installed in Photoshop. This stayed
# AiImagePS for a long time, from when the plugin was called that: after the
# rename to ExactFill this script would have created a SECOND folder with the
# same manifest id next to the working one, instead of updating it. The gate is
# the test "deploy target matches the installed plugin folder".
DEST="/Applications/Adobe Photoshop 2026/Plug-ins/ExactFill"
SRC="$(cd "$(dirname "$0")" && pwd)"
EXCL=(--include 'icons/exactfill.svg' --include 'icons/panel-*.png' --exclude 'icons/*'
      --exclude '.git' --exclude 'test' --exclude 'CONTRACTS.md' --exclude 'PLATFORM.md'
      --exclude 'deploy.sh' --exclude 'INSTALL.txt'
      --exclude 'README.md' --exclude 'README.uk.md' --exclude 'LICENSE'
      --exclude 'PRIVACY.md' --exclude 'SUPPORT.md' --exclude 'SECURITY.md'
      --exclude 'CONTRIBUTING.md' --exclude 'CHANGELOG.md'
      --exclude 'package.json' --exclude '.gitignore' --exclude '.github'
      --exclude 'scripts' --exclude 'dist' --exclude 'node_modules' --exclude 'docs'
      --exclude 'verify' --exclude 'verify-assumptions.psjs' --exclude '.DS_Store')

if [ -d "$DEST" ] && [ -w "$DEST" ]; then
    rsync -a --delete --delete-excluded "${EXCL[@]}" "$SRC/" "$DEST/"
    echo "✓ Updated without a password: $DEST"
else
    echo "First install — a password is required (Plug-ins is owned by root)."
    sudo rsync -a --delete --delete-excluded "${EXCL[@]}" "$SRC/" "$DEST/"
    sudo chown -R "$(id -un):staff" "$DEST"
    echo "✓ Installed: $DEST"
    echo "  Later updates will not need a password."
fi

echo "  Restart Photoshop → Plugins → ExactFill"
