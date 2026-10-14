@echo off
REM One-time: let camera phones on the same Wi-Fi send video to this laptop.
REM Right-click this file -> "Run as administrator".
net session >nul 2>&1 || (echo Please right-click this file and choose "Run as administrator". & pause & exit /b 1)
netsh advfirewall firewall delete rule name="RANGVAASA camera video" >nul 2>&1
netsh advfirewall firewall add rule name="RANGVAASA camera video" dir=in action=allow protocol=UDP localport=8189
netsh advfirewall firewall add rule name="RANGVAASA camera video" dir=in action=allow protocol=TCP localport=8189
echo Done. Camera phones on this Wi-Fi can now reach the laptop.
pause
