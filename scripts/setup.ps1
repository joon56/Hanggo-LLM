param([string]$HanggoHome = 'D:\hanggo', [string[]]$Groups = @('core'))
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath (Split-Path -Parent $PSScriptRoot)
$nodeMajor = [int]((node --version).TrimStart('v').Split('.')[0])
if ($nodeMajor -ne 24) { throw 'Node.js 24 LTS is required.' }
$probe = if ($env:FFPROBE_PATH) { $env:FFPROBE_PATH } else { 'ffprobe' }
if (-not (Get-Command $probe -ErrorAction SilentlyContinue)) { throw 'Install FFmpeg and add ffprobe to PATH, or set FFPROBE_PATH.' }
& $probe -version | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'ffprobe could not run.' }

New-Item -ItemType Directory -Force -Path $HanggoHome | Out-Null
npm.cmd ci --cache (Join-Path $HanggoHome 'cache\npm') --no-audit --no-fund
if ($LASTEXITCODE -ne 0) { throw 'Package install failed.' }
[IO.File]::WriteAllText((Join-Path (Get-Location) '.hanggo-home'), $HanggoHome)

$utf8 = [Text.UTF8Encoding]::new($false)
$settings = Join-Path $HanggoHome 'settings.env'
if (-not (Test-Path -LiteralPath $settings)) {
  [IO.File]::WriteAllText($settings, "AI_ENABLED=true`nFEATURE_OWNER_LOG_ENABLED=true`nFEATURE_BRIEF_ENABLED=true`nSPEECH_MODEL=qwen-asr`nLLM_MODEL=gemma4-12b`n", $utf8)
}
$secrets = Join-Path $HanggoHome 'secrets.env'
if (-not (Test-Path -LiteralPath $secrets)) {
  [IO.File]::WriteAllText($secrets, "# Local secrets. Keep outside the repository. Never paste values into chat or commits.`nAPP_ACCESS_PASSWORD=`nTURN_URLS=`nTURN_USERNAME=`nTURN_CREDENTIAL=`n", $utf8)
}
& (Join-Path $PSScriptRoot 'setup-models.ps1') -HanggoHome $HanggoHome -Groups $Groups
