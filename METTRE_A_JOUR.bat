@echo off
setlocal EnableExtensions
title Vocalis - Mise a jour

rem ============================================================
rem  VOCALIS - MISE A JOUR EN 1 CLIC (Windows 10/11)
rem
rem  Le depot GitHub est PRIVE : les telechargements anonymes
rem  renvoient 404. La mise a jour passe donc par TON git
rem  (celui qui push deja, avec tes identifiants) :
rem    git fetch + reset --hard sur la branche de travail.
rem
rem  Si ce dossier n'est pas un clone git : message expliquant
rem  le clone unique a faire une fois.
rem
rem  Anti-ecrasement : ce fichier se copie dans %TEMP% et
rem  s'execute depuis la-bas (il peut donc se mettre a jour
rem  lui-meme).
rem ============================================================

rem --- bootstrap (double-clic, sans argument) ---
if not "%~1"=="" goto MAIN
copy /y "%~f0" "%TEMP%\vocalis-run.bat" >nul 2>&1
if errorlevel 1 ( echo [ERREUR] Preparation impossible. & pause & exit /b 1 )
call "%TEMP%\vocalis-run.bat" "%~dp0"
exit /b %errorlevel%

:MAIN
set "TARGET=%~1"
rem Enleve le \ final sinon "%TARGET%" mange la fin de la commande git
if "%TARGET:~-1%"=="\" set "TARGET=%TARGET:~0,-1%"
set "BRANCHE=arena/01a0b9bb-vocalis"

echo.
echo   VOCALIS - mise a jour
echo   Dossier : %TARGET%
echo.

rem --- chemin 1 : le dossier est un clone git (cas normal) ---
if exist "%TARGET%\.git\" goto VIAGIT
echo   Ce dossier n'est pas un clone git.
echo   Le depot etant prive, fais UN SEUL clone une fois :
echo.
echo     git clone https://github.com/gioledonuts-ui/vocalis.git
echo.
echo   Puis deplace ce dossier vide et relance la mise a jour
echo   depuis le clone.
echo.
pause
exit /b 1

:VIAGIT
where git.exe >nul 2>&1 || ( echo [ERREUR] git introuvable. & pause & exit /b 1 )

echo   Recuperation de la derniere version (via ton git)...
git -C "%TARGET%" fetch --quiet origin "%BRANCHE%"
if errorlevel 1 (
    echo   [ERREUR] git fetch a echoue. Verifie ta connexion / tes identifiants GitHub.
    pause
    exit /b 1
)

echo   Mise a jour des fichiers...
git -C "%TARGET%" reset --hard FETCH_HEAD
if errorlevel 1 (
    echo   [ERREUR] git reset a echoue.
    pause
    exit /b 1
)

echo.
echo   Mise a jour terminee.
echo   Ouvre chrome://extensions et clique sur "Actualiser" pour Vocalis.
echo   (Le modele IA, lui, vit dans extension\models : voir TELECHARGER_MODELE.bat)
echo.
pause
exit /b 0
