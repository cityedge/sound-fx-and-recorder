@echo off
setlocal EnableExtensions DisableDelayedExpansion
title WebM Opus Converter - FFmpeg

rem FFmpeg is found next to this BAT or in PATH. No ffprobe required.
set "FFMPEG=ffmpeg.exe"
if exist "%~dp0ffmpeg.exe" (
    set "FFMPEG=%~dp0ffmpeg.exe"
) else (
    where ffmpeg.exe >nul 2>nul
    if errorlevel 1 (
        echo [ERROR] FFmpeg was not found.
        echo Put ffmpeg.exe next to this BAT file, or add FFmpeg to PATH.
        echo.
        pause
        exit /b 1
    )
)

echo ======================================================
echo    WebM / Opus Converter  -  FFmpeg
echo ======================================================
echo.
echo Select the output format:
echo   [1] WAV   : 16-bit PCM, original channels/sample rate
echo   [2] MP3   : LAME VBR quality 2, original channels
echo   [3] WAV   : 16 kHz / mono, for speech transcription
echo.
choice /c 123 /n /m "Enter 1, 2, or 3: "
if errorlevel 3 (
    set "MODE=3"
) else if errorlevel 2 (
    set "MODE=2"
) else (
    set "MODE=1"
)

set /a TOTAL=0
set /a OK=0
set /a SKIPPED=0
set /a FAILED=0

echo.
if not "%~1"=="" goto dropped

echo No files were dropped; searching for .webm files in this BAT folder.
for %%F in ("%~dp0*.webm") do if exist "%%~fF" call :convert "%%~fF"
goto done

:dropped
if "%~1"=="" goto done
call :convert "%~f1"
shift
goto dropped

:convert
if not exist "%~1" (
    echo [SKIP] File not found: "%~1"
    set /a SKIPPED+=1
    exit /b 0
)
if /i not "%~x1"==".webm" (
    echo [SKIP] Not a .webm file: "%~nx1"
    set /a SKIPPED+=1
    exit /b 0
)
set /a TOTAL+=1
if "%MODE%"=="1" (
    set "OUTPUT=%~dpn1.wav"
) else if "%MODE%"=="2" (
    set "OUTPUT=%~dpn1.mp3"
) else (
    set "OUTPUT=%~dpn1.speech16k.wav"
)

if exist "%OUTPUT%" (
    echo [SKIP] Output already exists: "%OUTPUT%"
    set /a SKIPPED+=1
    exit /b 0
)

echo [CONVERT] "%~nx1"
if "%MODE%"=="1" (
    "%FFMPEG%" -hide_banner -loglevel error -stats -nostdin -n -i "%~f1" -map 0:a:0 -vn -sn -dn -c:a pcm_s16le "%OUTPUT%"
) else if "%MODE%"=="2" (
    "%FFMPEG%" -hide_banner -loglevel error -stats -nostdin -n -i "%~f1" -map 0:a:0 -vn -sn -dn -c:a libmp3lame -q:a 2 -id3v2_version 3 "%OUTPUT%"
) else (
    "%FFMPEG%" -hide_banner -loglevel error -stats -nostdin -n -i "%~f1" -map 0:a:0 -vn -sn -dn -c:a pcm_s16le -ac 1 -ar 16000 "%OUTPUT%"
)
if errorlevel 1 (
    echo [FAILED] "%~nx1"
    set /a FAILED+=1
) else (
    echo [OK] "%OUTPUT%"
    set /a OK+=1
)
echo.
exit /b 0

:done
echo ======================================================
echo Converted: %OK%    Skipped: %SKIPPED%    Failed: %FAILED%
if "%TOTAL%"=="0" echo No valid .webm files were found.
echo Input WebM files are never deleted or overwritten.
echo ======================================================
pause
if %FAILED% GTR 0 exit /b 1
exit /b 0
