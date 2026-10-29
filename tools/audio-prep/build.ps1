$ErrorActionPreference = 'Stop'
$toolRoot = $PSScriptRoot
$repoRoot = (Resolve-Path -LiteralPath (Join-Path $toolRoot '../..')).Path
$compiler = Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
if (-not (Test-Path -LiteralPath $compiler)) { $compiler = Join-Path $env:WINDIR 'Microsoft.NET/Framework/v4.0.30319/csc.exe' }
if (-not (Test-Path -LiteralPath $compiler)) { throw 'Install a trusted .NET Framework developer environment first.' }
$outputDir = Join-Path $toolRoot 'bin'
New-Item -ItemType Directory -Force -Path $outputDir | Out-Null
$outputExe = Join-Path $outputDir 'AudioPrep.exe'
& $compiler /nologo /codepage:65001 /target:winexe /platform:anycpu /optimize+ /reference:System.Windows.Forms.dll /reference:System.Drawing.dll /reference:System.Web.Extensions.dll "/out:$outputExe" (Join-Path $toolRoot 'src/CinemaAudio.cs') (Join-Path $toolRoot 'src/Branding.cs')
if ($LASTEXITCODE -ne 0) { throw 'C# compilation failed.' }
Copy-Item -LiteralPath (Join-Path $toolRoot 'guide.html') -Destination $outputDir -Force
foreach ($file in @('LICENSE','NOTICE','THIRD_PARTY_NOTICES.md','DISCLAIMER.md')) {
  Copy-Item -LiteralPath (Join-Path $repoRoot $file) -Destination $outputDir -Force
}
Get-FileHash -LiteralPath $outputExe -Algorithm SHA256
