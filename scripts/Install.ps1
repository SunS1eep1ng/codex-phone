$ErrorActionPreference = 'Stop'
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Install Node >=24.16.0 first.' }
& node (Join-Path $PSScriptRoot 'install.mjs')
if ($LASTEXITCODE -ne 0) { throw ('codex-phone install failed: ' + $LASTEXITCODE) }
