$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath (Split-Path -Parent $PSScriptRoot)
$nodeMajor = [int]((node --version).TrimStart('v').Split('.')[0])
if ($nodeMajor -ne 24) { throw 'Node.js 24 LTS를 설치해 주세요.' }
$probe = if ($env:FFPROBE_PATH) { $env:FFPROBE_PATH } else { 'ffprobe' }
if (-not (Get-Command $probe -ErrorAction SilentlyContinue)) { throw 'FFmpeg를 설치해 ffprobe를 PATH에 추가하거나 FFPROBE_PATH 환경변수를 설정해 주세요.' }
& $probe -version | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'ffprobe를 실행할 수 없습니다.' }
npm.cmd ci --cache .tmp/npm-cache --no-audit --no-fund
if ($LASTEXITCODE -ne 0) { throw '패키지 설치 실패' }
if (-not (Test-Path -LiteralPath '.env')) { Copy-Item -LiteralPath '.env.example' -Destination '.env' }
Write-Host '.env에 OPENAI_API_KEY를 넣고 AI_ENABLED=true로 설정하세요. 키를 채팅에 붙이지 마세요.'
Write-Host '전체 기능: FEATURE_OWNER_LOG_ENABLED, FEATURE_BRIEF_ENABLED, FEATURE_SHELTER_ENABLED를 true로 설정하세요.'
Write-Host '실행: npm.cmd run dev'
