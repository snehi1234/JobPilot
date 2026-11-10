# build-extension.ps1 — packages JobPilot into a clean zip for the Chrome Web
# Store, including only the files the extension actually needs at runtime and
# excluding dev-only files (backend/, icons/node_modules, source .svg, etc).
#
# Usage: powershell -File build-extension.ps1
# Output: dist/jobpilot-extension.zip

$ErrorActionPreference = "Stop"

$root = $PSScriptRoot
$distDir = Join-Path $root "dist"
$stageDir = Join-Path $distDir "stage"
$zipPath = Join-Path $distDir "jobpilot-extension.zip"

# Clean previous build
if (Test-Path $distDir) { Remove-Item $distDir -Recurse -Force }
New-Item -ItemType Directory -Path $stageDir -Force | Out-Null

# Files/folders required by manifest.json + runtime code.
$filesToCopy = @(
  "manifest.json",
  "background.js",
  "content-ui.js",
  "content.js",
  "config.js",
  "auth.js",
  "cloud.js",
  "sidepanel.html",
  "sidepanel.js",
  "sidepanel.css",
  "onboarding.html",
  "onboarding.js",
  "onboarding.css",
  "privacy.html",
  "terms.html"
)

foreach ($f in $filesToCopy) {
  $src = Join-Path $root $f
  if (Test-Path $src) {
    Copy-Item $src -Destination (Join-Path $stageDir $f)
  } else {
    Write-Warning "Missing expected file: $f"
  }
}

# icons/ — only the PNGs actually referenced by manifest.json (skip node_modules,
# package.json, .svg source, render script).
$iconsDest = Join-Path $stageDir "icons"
New-Item -ItemType Directory -Path $iconsDest -Force | Out-Null
foreach ($icon in @("icon16.png", "icon48.png", "icon128.png")) {
  Copy-Item (Join-Path $root "icons\$icon") -Destination (Join-Path $iconsDest $icon)
}

# lib/ — pdf.js runtime files only.
$libDest = Join-Path $stageDir "lib"
New-Item -ItemType Directory -Path $libDest -Force | Out-Null
foreach ($libFile in @("pdf.min.mjs", "pdf.worker.min.mjs", "jszip.min.js", "resume-profile.mjs", "answer-engine.mjs", "match-score.mjs", "job-description.mjs")) {
  Copy-Item (Join-Path $root "lib\$libFile") -Destination (Join-Path $libDest $libFile)
}

# Zip it up.
Compress-Archive -Path (Join-Path $stageDir "*") -DestinationPath $zipPath -Force

Write-Host "`nBuilt: $zipPath" -ForegroundColor Green
Write-Host "Contents:" -ForegroundColor Cyan
Get-ChildItem -Recurse $stageDir | ForEach-Object {
  $rel = $_.FullName.Substring($stageDir.Length + 1)
  Write-Host "  $rel"
}
