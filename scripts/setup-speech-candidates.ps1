$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$downloadRoot = Join-Path $projectRoot '.local-ai/candidates/downloads'
$modelRoot = Join-Path $projectRoot '.local-ai/candidates/models'
New-Item -ItemType Directory -Force -Path $downloadRoot, $modelRoot | Out-Null

# Fixed upstream versions. Keep the current speech installation available for comparison.
$files = @(
    @('whisper-cuda.zip', 'https://github.com/ggml-org/whisper.cpp/releases/download/b5454/whisper-bin-win-cuda-12.4.0-x64.zip', 'afef0b881c500958921c3f5523b50e59ee2ec9b6f5cbd25b324c51ed308a957a', 684913404),
    @('llama-cuda.zip', 'https://github.com/ggml-org/llama.cpp/releases/download/b11457/llama-b11457-bin-win-cuda-12.4-x64.zip', 'c901dbb473c9472288e38ef06bf85e4e13d7de6bb24732b03dbe8aa05fcc483c', 264528387),
    @('llama-cudart.zip', 'https://github.com/ggml-org/llama.cpp/releases/download/b11457/cudart-llama-bin-win-cuda-12.4-x64.zip', '8c79a9b226de4b3cacfd1f83d24f962d0773be79f1e7b75c6af4ded7e32ae1d6', 391443627),
    @('ggml-large-v3-turbo.bin', 'https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-large-v3-turbo.bin?download=true', '1fc70f774d38eb169993ac391eea357ef47c88757ef72ee5943879b7e8e2bc69', 1624555275),
    @('ggml-large-v3.bin', 'https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-large-v3.bin?download=true', '64d182b440b98d5203c4f9bd541544d84c605196c4f7b845dfa11fb23594d1e2', 3095033483),
    @('Qwen3-ASR-1.7B-bf16.gguf', 'https://huggingface.co/ggml-org/Qwen3-ASR-1.7B-GGUF/resolve/36a678687ba7d07a74ca70ccb0e36902e005fb80/Qwen3-ASR-1.7B-bf16.gguf?download=true', '1af18763dfafde2bbf071ef8a0952f7bee66f140c3565e5ccc5afb07dc1f9227', 4069674944),
    @('mmproj-Qwen3-ASR-1.7B-bf16.gguf', 'https://huggingface.co/ggml-org/Qwen3-ASR-1.7B-GGUF/resolve/36a678687ba7d07a74ca70ccb0e36902e005fb80/mmproj-Qwen3-ASR-1.7B-bf16.gguf?download=true', '8882e9ddab3186f9aa71b1417c847177913e1466655ac944cf86e9b846735d62', 641773984)
)

foreach ($file in $files) {
    $targetRoot = if ($file[0].EndsWith('.zip')) { $downloadRoot } else { $modelRoot }
    $target = Join-Path $targetRoot $file[0]
    if (Test-Path -LiteralPath $target) {
        if ((Get-Item -LiteralPath $target).Length -eq $file[3] -and (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash -eq $file[2]) {
            Write-Host "Verified existing: $($file[0])"
            continue
        }
        throw "Existing file failed verification: $target. Preserve it and inspect before retrying."
    }
    $partial = "$target.partial"
    Write-Host "Downloading: $($file[0]) ($($file[3]) bytes)"
    & curl.exe --fail --location --silent --show-error --retry 3 --connect-timeout 30 --speed-time 120 --speed-limit 1024 --continue-at - --output $partial $file[1]
    if ($LASTEXITCODE -ne 0) { throw "Download failed: $($file[0]). Re-run to resume." }
    if ((Get-Item -LiteralPath $partial).Length -ne $file[3] -or (Get-FileHash -LiteralPath $partial -Algorithm SHA256).Hash -ne $file[2]) {
        throw "Download failed SHA-256 or size verification: $($file[0])"
    }
    Move-Item -LiteralPath $partial -Destination $target
    Write-Host "Verified: $($file[0])"
}

$whisperRoot = Join-Path $projectRoot '.local-ai/candidates/whisper-cuda'
$llamaRoot = Join-Path $projectRoot '.local-ai/candidates/llama-cuda'
Expand-Archive -LiteralPath (Join-Path $downloadRoot 'whisper-cuda.zip') -DestinationPath $whisperRoot -Force
Expand-Archive -LiteralPath (Join-Path $downloadRoot 'llama-cuda.zip') -DestinationPath $llamaRoot -Force
Expand-Archive -LiteralPath (Join-Path $downloadRoot 'llama-cudart.zip') -DestinationPath $llamaRoot -Force
Write-Host 'Speech comparison candidates downloaded and verified. Application defaults were not changed.'
