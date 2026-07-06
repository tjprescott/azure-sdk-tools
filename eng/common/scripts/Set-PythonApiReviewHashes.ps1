[CmdletBinding()]
param(
  [Parameter(Mandatory = $false)]
  [array]$ArtifactList,
  [Parameter(Mandatory = $true)]
  [string]$ArtifactPath,
  [string]$ConfigFileDir,
  [Parameter(Mandatory = $false)]
  [array]$PackageInfoFiles
)

Set-StrictMode -Version 3
$ErrorActionPreference = 'Stop'

function Resolve-PackageInfoFiles([array]$ArtifactList, [string]$ConfigFileDir, [array]$PackageInfoFiles)
{
  $resolvedFiles = @()
  if ($ArtifactList -and $ArtifactList.Count -gt 0)
  {
    foreach ($artifact in $ArtifactList)
    {
      $packageInfoPath = Join-Path -Path $ConfigFileDir -ChildPath "$($artifact.name).json"
      if (Test-Path $packageInfoPath)
      {
        $resolvedFiles += $packageInfoPath
      }
      else
      {
        Write-Warning "Package info file $packageInfoPath was not found."
      }
    }
  }
  elseif ($PackageInfoFiles -and $PackageInfoFiles.Count -gt 0)
  {
    foreach ($packageInfoFile in @($PackageInfoFiles | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }))
    {
      if (Test-Path $packageInfoFile)
      {
        $resolvedFiles += $packageInfoFile
        continue
      }

      $packageInfoPath = Join-Path -Path $ConfigFileDir -ChildPath $packageInfoFile
      if (Test-Path $packageInfoPath)
      {
        $resolvedFiles += $packageInfoPath
      }
      else
      {
        Write-Warning "Package info file $packageInfoFile was not found."
      }
    }
  }

  return $resolvedFiles
}

function Get-OptionalProperty($value, [string]$propertyName)
{
  if ($value.PSObject.Properties.Name -contains $propertyName)
  {
    return $value.$propertyName
  }
  return $null
}

function Get-PackageArtifactName($packageInfo)
{
  $artifactName = Get-OptionalProperty $packageInfo "ArtifactName"
  if ($artifactName)
  {
    return $artifactName
  }
  return $packageInfo.Name
}

function Get-GeneratedApiFile([string]$packageArtifactPath)
{
  $directPath = Join-Path -Path $packageArtifactPath -ChildPath "api.md"
  if (Test-Path $directPath)
  {
    return $directPath
  }

  $matches = @(Get-ChildItem -Path $packageArtifactPath -Filter "api.md" -File -Recurse -ErrorAction SilentlyContinue)
  if ($matches.Count -eq 1)
  {
    return $matches[0].FullName
  }

  if ($matches.Count -gt 1)
  {
    Write-Warning "Found multiple api.md files under $packageArtifactPath. Expected one generated Python API review artifact."
  }
  return $null
}

function Set-Property($value, [string]$propertyName, $propertyValue)
{
  if ($value.PSObject.Properties.Name -contains $propertyName)
  {
    $value.$propertyName = $propertyValue
  }
  else
  {
    $value | Add-Member -NotePropertyName $propertyName -NotePropertyValue $propertyValue
  }
}

if (-not $ConfigFileDir)
{
  $ConfigFileDir = Join-Path -Path $ArtifactPath -ChildPath "PackageInfo"
}

Write-Host "Setting Python API review hashes from generated api.md artifacts."
Write-Host "Artifact path: $ArtifactPath"
Write-Host "Config file path: $ConfigFileDir"

$resolvedPackageInfoFiles = @(Resolve-PackageInfoFiles $ArtifactList $ConfigFileDir $PackageInfoFiles)
if (-not $resolvedPackageInfoFiles -or $resolvedPackageInfoFiles.Count -eq 0)
{
  Write-Warning "No package info files found. Skipping Python API review hash update."
  return
}

foreach ($packageInfoFile in $resolvedPackageInfoFiles)
{
  $packageInfo = Get-Content -Raw -Path $packageInfoFile | ConvertFrom-Json
  $artifactName = Get-PackageArtifactName $packageInfo
  $packageArtifactPath = Join-Path -Path $ArtifactPath -ChildPath $artifactName
  if (-not (Test-Path $packageArtifactPath))
  {
    Write-Warning "Package artifact path $packageArtifactPath was not found. Skipping API hash for $artifactName."
    continue
  }

  $apiMdPath = Get-GeneratedApiFile $packageArtifactPath
  if (-not $apiMdPath)
  {
    Write-Warning "Generated api.md was not found under $packageArtifactPath. Skipping API hash for $artifactName."
    continue
  }

  $apiHash = (Get-FileHash -Algorithm SHA256 -Path $apiMdPath).Hash.ToLowerInvariant()
  Set-Property $packageInfo "ApiHash" $apiHash
  $packageInfo | ConvertTo-Json -Depth 100 | Set-Content -Path $packageInfoFile -Encoding utf8
  Write-Host "Set ApiHash for $artifactName from $apiMdPath."
}