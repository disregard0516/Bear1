@echo off
cd /d "%~dp0"
echo Starting BakaBoost preview with webhook support...
echo Open http://127.0.0.1:3005/
node server.js
pause
