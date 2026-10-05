@echo off
chcp 65001 >nul
title Chess Repertoire Studio
cd /d "%~dp0"

echo ============================================================
echo   Chess Repertoire Studio - Demarrage
echo ============================================================

where npm >nul 2>nul
if errorlevel 1 (
  echo [ERREUR] Node.js / npm introuvable.
  echo Installe Node.js LTS depuis https://nodejs.org puis relance start.bat
  pause
  exit /b 1
)

where python >nul 2>nul
if errorlevel 1 (
  echo [INFO] python introuvable, essai avec le lanceur "py"...
  where py >nul 2>nul
  if errorlevel 1 (
    echo [ERREUR] Python introuvable. Installe Python 3.11+ puis relance.
    pause
    exit /b 1
  )
  echo Lancement via py...
  py run_web.py
  if errorlevel 1 pause
  exit /b %errorlevel%
)

echo Lancement du serveur Vite sur http://localhost:5173 ...
echo Les ports 5173 et 8765 sont liberes automatiquement si un ancien serveur les occupe.
python run_web.py
if errorlevel 1 (
  echo.
  echo [ERREUR] Le serveur s'est arrete avec un probleme.
  pause
)
