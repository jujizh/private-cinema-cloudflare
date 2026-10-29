# SPDX-License-Identifier: Apache-2.0
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$toolRoot = Join-Path $repoRoot 'tools/audio-prep'
& (Join-Path $toolRoot 'build.ps1')
$archivePath = Join-Path (Split-Path -Parent $repoRoot) 'private-cinema-audio-prep-windows-1.1.zip'
$entries = @{}
foreach ($file in @('AudioPrep.exe','guide.html','LICENSE','NOTICE','DISCLAIMER.md','THIRD_PARTY_NOTICES.md')) {
  $entries[$file] = Join-Path $toolRoot ('bin/' + $file)
}
foreach ($file in @('README.md','build.ps1','build.cmd','test.ps1','guide.html')) {
  $entries['tools/audio-prep/' + $file] = Join-Path $toolRoot $file
}
foreach ($file in @('CinemaAudio.cs','Branding.cs')) { $entries['tools/audio-prep/src/' + $file] = Join-Path $toolRoot ('src/' + $file) }
$entries['docs/AUDIO.md'] = Join-Path $repoRoot 'docs/AUDIO.md'
$stream = [IO.File]::Open($archivePath,[IO.FileMode]::CreateNew)
$archive = [IO.Compression.ZipArchive]::new($stream,[IO.Compression.ZipArchiveMode]::Create)
try {
  foreach ($name in ($entries.Keys | Sort-Object)) {
    [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive,$entries[$name],$name,[IO.Compression.CompressionLevel]::Optimal) | Out-Null
  }
} finally { $archive.Dispose(); $stream.Dispose() }
$read = [IO.Compression.ZipFile]::OpenRead($archivePath)
try {
  foreach ($entry in $read.Entries) {
    if ($entry.Name -match '^ff(?:mpeg|probe)') { throw 'FFmpeg must not be bundled.' }
    $entryStream=$entry.Open(); $hash=[Security.Cryptography.SHA256]::Create()
    try { $actual=([BitConverter]::ToString($hash.ComputeHash($entryStream))).Replace('-','') }
    finally { $entryStream.Dispose(); $hash.Dispose() }
    if ($actual -ne (Get-FileHash -LiteralPath $entries[$entry.FullName] -Algorithm SHA256).Hash) { throw 'Audio package checksum mismatch.' }
  }
  [pscustomobject]@{File=(Split-Path -Leaf $archivePath); Entries=$read.Entries.Count;
    Bytes=(Get-Item -LiteralPath $archivePath).Length; SHA256=(Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash} | Format-List
} finally { $read.Dispose() }
