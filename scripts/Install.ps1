param([string]$StateDirectory, [switch]$NoShortcuts)
$ErrorActionPreference = 'Stop'
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Install Node >=24.16.0 first.' }
$phoneArguments = @((Join-Path $PSScriptRoot 'install.mjs'))
if ($StateDirectory) { $phoneArguments += @('--state', $StateDirectory) }
if ($NoShortcuts) { $phoneArguments += '--no-shortcuts' }
& node @phoneArguments
if ($LASTEXITCODE -ne 0) { throw ('codex-phone install failed: ' + $LASTEXITCODE) }
