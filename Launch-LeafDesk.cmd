@echo off
chcp 65001 >nul
REM 正式版；勿用 cargo run / tauri dev（会连 localhost 失败）
set "EXE=%~dp0src-tauri\target\release\leaf_desk.exe"

if exist "%EXE%" (

  start "" "%EXE%"

  exit /b 0

)

set "INST=%LocalAppData%\Programs\LeafDesk\leaf_desk.exe"

if exist "%INST%" (

  start "" "%INST%"

  exit /b 0

)

echo 未找到 leaf_desk.exe，请先运行: npm run build:client

pause


