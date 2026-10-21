@echo off
chcp 65001 >nul
set "ROOT=%~dp0"
set "RELEASE=%ROOT%src-tauri\target\release\leaf_desk.exe"

for /d %%D in ("%ROOT%dist-portable\*-x64-portable") do (
  if exist "%%~fD\leaf_desk.exe" (
    start "" /D "%%~fD" "%%~fD\leaf_desk.exe"
    exit /b 0
  )
)

if exist "%RELEASE%" (
  start "" /D "%ROOT%src-tauri\target\release" "%RELEASE%"
  exit /b 0
)

set "INST=%LocalAppData%\Programs\LeafDesk\leaf_desk.exe"
if exist "%INST%" (
  start "" "%INST%"
  exit /b 0
)

echo 未找到叶桌，请先运行: npm run pack:portable:build
pause
