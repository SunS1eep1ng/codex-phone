param([Parameter(ValueFromRemainingArguments=$true)][string[]]$Arguments)
$ErrorActionPreference = 'Stop'
$phoneCli = Join-Path $PSScriptRoot 'manage.mjs'
if (-not (Test-Path -LiteralPath $phoneCli)) { throw 'Run Install.ps1 first.' }
& node $phoneCli @Arguments
exit $LASTEXITCODE
