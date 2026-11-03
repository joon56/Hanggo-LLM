param(
  [string]$HanggoHome = $(if ($env:HANGGO_HOME) { $env:HANGGO_HOME } else { 'D:\hanggo' }),
  [string[]]$Groups = @('core')
)
$ErrorActionPreference = 'Stop'
$manifest = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'models.manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$entries = @($manifest | Where-Object { $Groups -contains $_.group })
if (-not $entries.Count) { throw "No manifest entries for groups: $($Groups -join ', ')" }

$downloads = Join-Path $HanggoHome 'cache\downloads'
New-Item -ItemType Directory -Force -Path $downloads | Out-Null
$root = [IO.Path]::GetPathRoot((Resolve-Path -LiteralPath $HanggoHome).Path)

function Test-Verified([string]$path, $entry) {
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return $false }
  if ((Get-Item -LiteralPath $path).Length -ne $entry.size) { return $false }
  return (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() -eq $entry.sha256
}

$report = @()
foreach ($entry in $entries) {
  $isArchive = [bool]$entry.extract
  $relative = $entry.dest -replace '/', '\'
  $target = if ($isArchive) { Join-Path $downloads ([IO.Path]::GetFileName(([Uri]$entry.url).AbsolutePath)) } else { Join-Path $HanggoHome $relative }
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $target) | Out-Null

  $status = 'verified-existing'
  if (-not (Test-Verified $target $entry)) {
    $partial = "$target.partial"
    $have = if (Test-Path -LiteralPath $partial) { (Get-Item -LiteralPath $partial).Length } else { 0 }
    $free = (New-Object IO.DriveInfo($root)).AvailableFreeSpace
    if ($free -lt ($entry.size - $have + 1GB)) { throw "Not enough free space for $($entry.id) on $root" }
    if (Test-Path -LiteralPath $target) { throw "Existing file failed verification: $target. Inspect it before retrying." }
    Write-Host "Downloading $($entry.id) ($([math]::Round($entry.size / 1GB, 2)) GiB)"
    & curl.exe --fail --location --silent --show-error --retry 5 --retry-delay 5 --connect-timeout 30 --speed-time 120 --speed-limit 1024 --continue-at - --output $partial $entry.url
    if ($LASTEXITCODE -ne 0) { throw "Download failed: $($entry.id). Run again to resume." }
    if (-not (Test-Verified $partial $entry)) { throw "Size or SHA-256 check failed: $($entry.id). Partial kept at $partial." }
    Move-Item -LiteralPath $partial -Destination $target
    $status = 'downloaded'
  }

  if ($isArchive) {
    $destination = Join-Path $HanggoHome $relative
    $marker = Join-Path $destination ".extracted-$($entry.id)-$($entry.sha256.Substring(0, 12))"
    if (-not (Test-Path -LiteralPath $marker)) {
      New-Item -ItemType Directory -Force -Path $destination | Out-Null
      if ($entry.extract -eq 'zip') { Expand-Archive -LiteralPath $target -DestinationPath $destination -Force }
      else {
        & "$env:SystemRoot\System32\tar.exe" -xzf $target -C $destination
        if ($LASTEXITCODE -ne 0) { throw "Extraction failed: $($entry.id)" }
      }
      Set-Content -LiteralPath $marker -Value $entry.sha256 -Encoding ASCII
    }
  }
  Write-Host "$($entry.id): $status"
  $report += [pscustomobject]@{ id = $entry.id; group = $entry.group; status = $status; size = $entry.size; sha256 = $entry.sha256; checkedAt = (Get-Date).ToString('o') }
}
$report | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $HanggoHome 'cache\install-report.json') -Encoding UTF8
Write-Host "Installed $($report.Count) entries under $HanggoHome"
