@echo off
REM ============================================================
REM  RANGVAASA Live - event night, run from this laptop (no VPS)
REM  Starts the streaming engine, the app, and the Cloudflare
REM  Tunnel that puts it online at your domain.
REM  Keep this window open and the laptop plugged in.
REM ============================================================
setlocal
set MTX_VERSION=v1.21.2
cd /d "%~dp0"

REM Read TUNNEL_TOKEN from .env
set TUNNEL_TOKEN=
if exist .env for /f "usebackq tokens=1,* delims==" %%a in (".env") do if "%%a"=="TUNNEL_TOKEN" set TUNNEL_TOKEN=%%b

REM First run: download the streaming engine
if not exist server\bin\mediamtx.exe (
  echo Downloading MediaMTX %MTX_VERSION%...
  if not exist server\bin mkdir server\bin
  curl -fL -o server\bin\mediamtx.zip https://github.com/bluenviron/mediamtx/releases/download/%MTX_VERSION%/mediamtx_%MTX_VERSION%_windows_amd64.zip || goto :fail
  tar -xf server\bin\mediamtx.zip -C server\bin || goto :fail
  del server\bin\mediamtx.zip
)

REM First run: download Cloudflare Tunnel
if not exist tools\cloudflared.exe (
  echo Downloading Cloudflare Tunnel...
  if not exist tools mkdir tools
  curl -fL -o tools\cloudflared.exe https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe || goto :fail
)

REM First run: download FFmpeg - sends the stream to YouTube, Facebook and Instagram
if not exist tools\ffmpeg.exe (
  echo Downloading FFmpeg for YouTube / Facebook / Instagram...
  curl -fL --retry 5 -C - -o tools\ffmpeg.zip https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip || goto :fail
  "%SystemRoot%\System32\tar.exe" -xf tools\ffmpeg.zip -C tools --strip-components 2 "ffmpeg-master-latest-win64-gpl/bin/ffmpeg.exe" || goto :fail
  del tools\ffmpeg.zip
)

REM Keep the laptop awake while plugged in
powercfg /change standby-timeout-ac 0 >nul 2>&1
powercfg /change monitor-timeout-ac 0 >nul 2>&1

start "RANGVAASA - streaming engine" /min cmd /c "cd /d "%~dp0server" && bin\mediamtx.exe mediamtx.yml"
start "RANGVAASA - app" /min cmd /c "cd /d "%~dp0" && node serve.js"

echo.
echo   App running on this laptop:  http://localhost:8080
echo   Camera phones on this Wi-Fi: use the public link below + /studio
echo.

if defined TUNNEL_TOKEN goto :named

echo   No TUNNEL_TOKEN in .env, so using a temporary link.
echo   The website is updated to the new link automatically - keep the windows open.
echo.
start "RANGVAASA - website link" /min cmd /c "cd /d "%~dp0" && node deploy\keep-link.js"
:quick
tools\cloudflared.exe tunnel --no-autoupdate --metrics 127.0.0.1:20241 --url http://localhost:8080
echo   Tunnel stopped - starting a new one in 3 seconds...
timeout /t 3 /nobreak >nul
goto :quick

:named
echo   Going online through your Cloudflare Tunnel...
echo   Viewers: https://YOUR-DOMAIN   Cameras: /studio   Control room: /admin
echo.
tools\cloudflared.exe tunnel --no-autoupdate run --token %TUNNEL_TOKEN%
echo   Tunnel stopped - reconnecting in 3 seconds...
timeout /t 3 /nobreak >nul
goto :named

:fail
echo Download failed. Check the internet connection and try again.
pause
