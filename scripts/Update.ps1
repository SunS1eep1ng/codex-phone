$ErrorActionPreference = 'Stop'
& node (Join-Path $PSScriptRoot 'install.mjs') --upgrade
if ($LASTEXITCODE -ne 0) { throw ('codex-phone update failed: ' + $LASTEXITCODE) }
