@echo off
chcp 65001 >nul
REM 正式版；勿用 cargo run / tauri dev（会连 localhost 失败）
set "ROOT=%~dp0"
set "EXE=%ROOT%src-tauri\target\release\leaf_desk.exe"

for /d %%D in ("%ROOT%dist-portable\*-x64-portable") do (
  if exist "%%~fD\leaf_desk.exe" (
    start "" /D "%%~fD" "%%~fD\leaf_desk.exe"
    exit /b 0
  )
)

if exist "%EXE%" (
  start "" /D "%ROOT%src-tauri\target\release" "%EXE%"
  exit /b 0
)

set "INST=%LocalAppData%\Programs\LeafDesk\leaf_desk.exe"

if exist "%INST%" (

  start "" "%INST%"

  exit /b 0

)

echo 未找到 leaf_desk.exe，请先运行: npm run build:client

pause


