@echo off
setlocal
set "CINEMA_COMPILER=%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if not exist "%CINEMA_COMPILER%" set "CINEMA_COMPILER=%WINDIR%\Microsoft.NET\Framework\v4.0.30319\csc.exe"
if not exist "%CINEMA_COMPILER%" (
  echo A trusted .NET Framework developer environment is required.
  exit /b 1
)
if not exist "%~dp0bin" mkdir "%~dp0bin"
"%CINEMA_COMPILER%" /nologo /codepage:65001 /target:winexe /platform:anycpu /optimize+ /reference:System.Windows.Forms.dll /reference:System.Drawing.dll /reference:System.Web.Extensions.dll /out:"%~dp0bin\AudioPrep.exe" "%~dp0src\CinemaAudio.cs" "%~dp0src\Branding.cs"
if errorlevel 1 exit /b 1
copy /y "%~dp0guide.html" "%~dp0bin\guide.html" >nul
for %%F in (LICENSE NOTICE THIRD_PARTY_NOTICES.md DISCLAIMER.md) do copy /y "%~dp0..\..\%%F" "%~dp0bin\%%F" >nul
echo Built locally. FFmpeg is not bundled. Output SHA-256:
certutil -hashfile "%~dp0bin\AudioPrep.exe" SHA256
endlocal
