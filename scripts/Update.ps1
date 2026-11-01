param([string]$StateDirectory, [switch]$NoShortcuts)
$ErrorActionPreference = 'Stop'
$phoneArguments = @((Join-Path $PSScriptRoot 'install.mjs'), '--upgrade')
if ($StateDirectory) { $phoneArguments += @('--state', $StateDirectory) }
if ($NoShortcuts) { $phoneArguments += '--no-shortcuts' }
& node @phoneArguments
if ($LASTEXITCODE -ne 0) { throw ('codex-phone update failed: ' + $LASTEXITCODE) }
