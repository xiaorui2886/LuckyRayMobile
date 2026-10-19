@echo off
rem Portable manual CLI entry. The Gradle task invokes node directly.
rem Resolve this checkout's dependency tree without npm redispatch.
setlocal
pushd "%~dp0.." || exit /b 1
node "%~dp0..\node_modules\@tauri-apps\cli\tauri.js" %*
set "TAURI_EXIT_CODE=%ERRORLEVEL%"
popd
exit /b %TAURI_EXIT_CODE%
