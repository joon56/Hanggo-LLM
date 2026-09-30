param()

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$install = Join-Path $repo '.local-ai'
$binaryDir = Join-Path $install 'whisper'
$modelDir = Join-Path $install 'models'
$binary = Join-Path $binaryDir 'whisper-cli.exe'
$model = Join-Path $modelDir 'ggml-medium-q5_0.bin'
$binaryUrl = 'https://github.com/ggml-org/whisper.cpp/releases/download/b5130/whisper-bin-x64.zip'
$binaryHash = 'f9ec6c52a2e949b62ab51fa21d0d497958f9e41c3010c157c4e42932d5316f3c'
$modelUrl = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/98aa99a0a9db05ae2342309f5096248665f7cba3/ggml-medium-q5_0.bin?download=true'
$modelHash = '19fea4b380c3a618ec4723c3eef2eb785ffba0d0538cf43f8f235e7b3b34220f'
$modelLength = [long]539212467

function Assert-Hash($path, $expected) {
  if ((Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expected) {
    throw "SHA256 mismatch: $path"
  }
}

function Download-Verified($url, $path, $expected) {
  $part = "$path.part"
  & curl.exe --fail --location --retry 3 --retry-all-errors --continue-at - --silent --show-error --max-time 1800 --output $part $url
  if ($LASTEXITCODE -ne 0) { throw "Download failed: $url" }
  Assert-Hash $part $expected
  Move-Item -LiteralPath $part -Destination $path -Force
}

function Download-Model {
  $chunkCount = 8
  $chunkSize = [long][Math]::Ceiling($modelLength / $chunkCount)
  $jobs = @()
  try {
    for ($index = 0; $index -lt $chunkCount; $index++) {
      $start = [long]$index * $chunkSize
      $end = [Math]::Min($modelLength - 1, $start + $chunkSize - 1)
      $part = "$model.chunk-$index"
      $headers = "$part.headers"
      $range = "bytes $start-$end/$modelLength"
      $valid = (Test-Path -LiteralPath $part) -and (Test-Path -LiteralPath $headers)
      if ($valid) {
        $valid = (Get-Item -LiteralPath $part).Length -eq ($end - $start + 1) -and
          (Get-Content -LiteralPath $headers -Raw) -match [regex]::Escape($range)
      }
      if (-not $valid) {
        # Start-Process joins ArgumentList items; quote file paths explicitly.
        $process = Start-Process -FilePath 'curl.exe' -ArgumentList @(
          '--fail', '--location', '--retry', '3', '--retry-all-errors', '--silent', '--show-error',
          '--max-time', '1800', '--range', "$start-$end", '--dump-header', "`"$headers`"",
          '--output', "`"$part`"", "`"$modelUrl`""
        ) -WindowStyle Hidden -PassThru
        $jobs += $process
      }
    }
    foreach ($process in $jobs) {
      $process.WaitForExit()
      if ($process.ExitCode -ne 0) { throw 'Model range download failed.' }
    }
  } finally {
    foreach ($process in $jobs) {
      if (-not $process.HasExited) { $process.Kill() }
      $process.WaitForExit()
      $process.Dispose()
    }
  }
  $assembled = "$model.part"
  $output = [System.IO.File]::Create($assembled)
  try {
    for ($index = 0; $index -lt $chunkCount; $index++) {
      $start = [long]$index * $chunkSize
      $end = [Math]::Min($modelLength - 1, $start + $chunkSize - 1)
      $part = "$model.chunk-$index"
      $headers = "$part.headers"
      if ((Get-Item -LiteralPath $part).Length -ne ($end - $start + 1) -or
          (Get-Content -LiteralPath $headers -Raw) -notmatch [regex]::Escape("bytes $start-$end/$modelLength")) {
        throw "Model range invalid: $index"
      }
      $inputFile = [System.IO.File]::OpenRead($part)
      try { $inputFile.CopyTo($output) } finally { $inputFile.Dispose() }
    }
  } finally { $output.Dispose() }
  Assert-Hash $assembled $modelHash
  Move-Item -LiteralPath $assembled -Destination $model -Force
  for ($index = 0; $index -lt $chunkCount; $index++) {
    Remove-Item -LiteralPath "$model.chunk-$index", "$model.chunk-$index.headers" -Force
  }
}

New-Item -ItemType Directory -Path $binaryDir, $modelDir -Force | Out-Null
$archive = Join-Path $install 'whisper-bin-x64.zip'
if (-not (Test-Path -LiteralPath $binary)) {
  if (-not (Test-Path -LiteralPath $archive)) {
    Download-Verified $binaryUrl $archive $binaryHash
  } else {
    Assert-Hash $archive $binaryHash
  }
  $staging = Join-Path $install 'whisper-staging'
  try {
    Expand-Archive -LiteralPath $archive -DestinationPath $staging -Force
    $found = Get-ChildItem -LiteralPath $staging -Filter whisper-cli.exe -File -Recurse | Select-Object -First 1
    if (-not $found) { throw 'whisper-cli.exe missing from verified archive.' }
    Copy-Item -Path (Join-Path $found.DirectoryName '*') -Destination $binaryDir -Recurse -Force
  } finally {
    $installPath = [System.IO.Path]::GetFullPath($install).TrimEnd('\')
    $stagingPath = [System.IO.Path]::GetFullPath($staging)
    if ($stagingPath -ne (Join-Path $installPath 'whisper-staging')) {
      throw 'Unsafe staging directory path.'
    }
    Remove-Item -LiteralPath $stagingPath -Recurse -Force -ErrorAction SilentlyContinue
  }
}
if (-not (Test-Path -LiteralPath $model)) {
  Download-Model
} else {
  Assert-Hash $model $modelHash
}
if (-not (Test-Path -LiteralPath $binary)) { throw 'whisper-cli.exe installation failed.' }
Write-Output "Whisper executable: $binary"
Write-Output "Whisper model: $model"
