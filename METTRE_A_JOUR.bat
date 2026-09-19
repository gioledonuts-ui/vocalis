@echo off
rem ============================================================
rem  VOCALIS - MISE A JOUR LOCALE
rem  Telecharge la derniere version depuis GitHub et met a jour
rem  ce dossier. Aucune installation, aucun git necessaire.
rem ============================================================
chcp 65001 >nul
title Vocalis - Mise a jour

rem On copie le script PowerShell dans TEMP pour pouvoir
rem ecraser les fichiers du dossier (y compris lui-meme).
copy /y "%~dp0scripts\update.ps1" "%TEMP%\vocalis-update.ps1" >nul 2>&1
if errorlevel 1 (
    echo [ERREUR] Impossible de trouver scripts\update.ps1 a cote de ce fichier.
    pause
    exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%TEMP%\vocalis-update.ps1" -TargetDir "%~dp0"
exit /b %errorlevel%
