$ErrorActionPreference = 'Stop'
& (Join-Path $PSScriptRoot 'build.ps1')
$exePath = Join-Path $PSScriptRoot 'bin/AudioPrep.exe'
$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../..')).Path
$testDir = Join-Path $repoRoot ('build-output/audio-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $testDir | Out-Null
$inputMedia = Join-Path $testDir 'synthetic input.mkv'
$outputAudio = Join-Path $testDir 'synthetic output.m4a'
& ffmpeg -hide_banner -v error -n -f lavfi -i 'color=c=black:s=320x180:r=24' -f lavfi -i 'sine=frequency=440:sample_rate=48000' -t 4 -c:v ffv1 -c:a pcm_s16le $inputMedia
if ($LASTEXITCODE -ne 0) { throw 'Synthetic fixture generation failed; install FFmpeg/ffprobe in PATH.' }
$before = (Get-FileHash -LiteralPath $inputMedia).Hash
$process = Start-Process -FilePath $exePath -ArgumentList '--argument-test' -Wait -PassThru -WindowStyle Hidden
if ($process.ExitCode -ne 0) { throw 'Windows argument quoting check failed.' }
$arguments = '--smoke-test "' + $inputMedia + '" "' + $outputAudio + '" 4'
$process = Start-Process -FilePath $exePath -ArgumentList $arguments -Wait -PassThru -WindowStyle Hidden
if ($process.ExitCode -ne 0) { throw 'Audio conversion test failed; inspect the local error file.' }
$probeText = & ffprobe -v error -show_streams -of json $outputAudio
if ($LASTEXITCODE -ne 0) { throw 'Output probe failed.' }
$probe = ($probeText -join "`n") | ConvertFrom-Json
if ($probe.streams.Count -ne 1 -or $probe.streams[0].codec_name -ne 'aac' -or $probe.streams[0].channels -ne 2) { throw 'Expected one stereo AAC stream without video.' }
if ($before -ne (Get-FileHash -LiteralPath $inputMedia).Hash) { throw 'Input was modified.' }
$originalOutputHash = (Get-FileHash -LiteralPath $outputAudio).Hash
$process = Start-Process -FilePath $exePath -ArgumentList $arguments -Wait -PassThru -WindowStyle Hidden
if ($process.ExitCode -eq 0) { throw 'Smoke-test output must not be overwritten.' }
if ($originalOutputHash -ne (Get-FileHash -LiteralPath $outputAudio).Hash) { throw 'Existing output was modified.' }
Write-Output 'PASS: argument escaping, synthetic AAC export, original preservation, overwrite refusal.'
Write-Output 'Only synthetic fixtures and their local logs were generated; no real movie was read.'
