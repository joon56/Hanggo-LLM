$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath (Split-Path -Parent $PSScriptRoot)
if (-not (Test-Path -LiteralPath 'node_modules')) { throw '먼저 scripts/setup.ps1을 실행하세요.' }
npm.cmd run dev
exit $LASTEXITCODE
