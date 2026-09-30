param([string]$Model = 'qwen3.5:9b', [switch]$SkipSpeech)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
Push-Location -LiteralPath $projectRoot
try {
  if (-not (Get-Command ollama -ErrorAction SilentlyContinue)) { throw 'Install Ollama from https://ollama.com/download/windows, then run this script again.' }
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Node.js 24 is required.' }
  if ($Model -notmatch '^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$') { throw 'Invalid Ollama model name.' }
  Write-Host "Downloading local text model: $Model (first run may take a while)"
  & ollama pull $Model
  if ($LASTEXITCODE -ne 0) { throw 'Ollama download failed. Start Ollama and retry; partial downloads are resumed.' }
  & node scripts/configure-local.mjs
  if ($LASTEXITCODE -ne 0) { throw 'Local configuration failed.' }
  # Set only this non-secret setting; preserve the rest of .env.
  $envFile = Join-Path $projectRoot '.env'
  $source = [IO.File]::ReadAllText($envFile)
  if ($source -match '(?m)^OLLAMA_MODEL=.*$') { $source = [regex]::Replace($source, '(?m)^OLLAMA_MODEL=.*$', "OLLAMA_MODEL=$Model") }
  else { $source = $source.TrimEnd() + "`nOLLAMA_MODEL=$Model`n" }
  [IO.File]::WriteAllText($envFile, $source, [Text.UTF8Encoding]::new($false))
  if (-not $SkipSpeech) { & (Join-Path $PSScriptRoot 'setup-local-speech.ps1') }
  & node --env-file-if-exists=.env scripts/check-local.ts
  if ($LASTEXITCODE -ne 0) { throw 'Some local dependencies are missing; see the checks above.' }
  Write-Host 'Ready. Run npm.cmd run dev:local and open http://127.0.0.1:5173/'
} finally { Pop-Location }
