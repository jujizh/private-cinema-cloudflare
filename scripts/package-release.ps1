# SPDX-License-Identifier: Apache-2.0
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
Push-Location $repoRoot
try {
  & node scripts/check-public.mjs
  if ($LASTEXITCODE -ne 0) { throw 'Public snapshot check failed.' }
  $rootNames = @('.gitignore','.gitattributes','.dev.vars.example','package.json','package-lock.json','wrangler.jsonc',
    'README.md','DEPLOY.md','LICENSE','NOTICE','COPYRIGHT.md','DISCLAIMER.md','THIRD_PARTY_NOTICES.md',
    'SECURITY.md','CONTRIBUTING.md','CHANGELOG.md','TESTING.md')
  $files = @($rootNames | ForEach-Object { Get-Item -LiteralPath (Join-Path $repoRoot $_) })
  foreach ($folder in @('public','src','test','scripts','docs','examples','.github')) {
    $files += Get-ChildItem -LiteralPath (Join-Path $repoRoot $folder) -Recurse -File -Force
  }
  $toolRoot = Join-Path $repoRoot 'tools/audio-prep'
  $files += Get-ChildItem -LiteralPath (Join-Path $toolRoot 'src') -File
  foreach ($file in @('README.md','guide.html','build.ps1','build.cmd','test.ps1')) { $files += Get-Item -LiteralPath (Join-Path $toolRoot $file) }
  $archivePath = Join-Path (Split-Path -Parent $repoRoot) 'private-cinema-open-source-v2.4.1.zip'
  $stream = [IO.File]::Open($archivePath, [IO.FileMode]::CreateNew)
  $archive = [IO.Compression.ZipArchive]::new($stream, [IO.Compression.ZipArchiveMode]::Create)
  try {
    foreach ($file in ($files | Sort-Object FullName)) {
      $relative = $file.FullName.Substring($repoRoot.Length + 1).Replace('\','/')
      if ($relative -match '(^|/)(node_modules|\.git|\.wrangler|bin|obj|build-output|dist)(/|$)' -or $relative -match '\.(exe|dll|zip|mkv|mp4|webm|m4a|log)$') { throw "Unexpected release file: $relative" }
      [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive,$file.FullName,$relative,[IO.Compression.CompressionLevel]::Optimal) | Out-Null
    }
  } finally { $archive.Dispose(); $stream.Dispose() }
  $readArchive = [IO.Compression.ZipFile]::OpenRead($archivePath)
  try {
    if ($readArchive.Entries.Count -ne $files.Count) { throw 'Archive count mismatch.' }
    foreach ($entry in $readArchive.Entries) {
      $sourceHash = (Get-FileHash -LiteralPath (Join-Path $repoRoot $entry.FullName) -Algorithm SHA256).Hash
      $entryStream = $entry.Open(); $hash = [Security.Cryptography.SHA256]::Create()
      try { $entryHash = ([BitConverter]::ToString($hash.ComputeHash($entryStream))).Replace('-','') }
      finally { $hash.Dispose(); $entryStream.Dispose() }
      if ($sourceHash -ne $entryHash) { throw "Archive content mismatch: $($entry.FullName)" }
    }
    [pscustomobject]@{ File=(Split-Path -Leaf $archivePath); Entries=$readArchive.Entries.Count;
      Bytes=(Get-Item -LiteralPath $archivePath).Length; SHA256=(Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash } | Format-List
  } finally { $readArchive.Dispose() }
} finally { Pop-Location }
