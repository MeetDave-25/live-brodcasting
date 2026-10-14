@echo off
REM Runs RANGVAASA Live on this PC for testing.
REM   Viewers: http://localhost:8080   Cameras: http://localhost:8080/studio   Admin: http://localhost:8080/admin
set MTX_VERSION=v1.21.2
cd /d "%~dp0server"

REM First run: download the streaming engine (MediaMTX) for Windows
if not exist bin\mediamtx.exe (
  echo Downloading MediaMTX %MTX_VERSION%...
  if not exist bin mkdir bin
  curl -fL -o bin\mediamtx.zip https://github.com/bluenviron/mediamtx/releases/download/%MTX_VERSION%/mediamtx_%MTX_VERSION%_windows_amd64.zip || goto :fail
  tar -xf bin\mediamtx.zip -C bin || goto :fail
  del bin\mediamtx.zip
)

start "MediaMTX" bin\mediamtx.exe mediamtx.yml
cd /d "%~dp0"
node serve.js
goto :eof

:fail
echo Could not download MediaMTX. Get it from https://github.com/bluenviron/mediamtx/releases and put mediamtx.exe in server\bin
pause
