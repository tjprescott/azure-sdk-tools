[CmdletBinding()]
param(
  [string]$Language = $env:API_REVIEW_LANGUAGE,
  [string]$PackageName = $env:API_REVIEW_PACKAGE_NAME,
  [string]$PackageVersion = $env:API_REVIEW_PACKAGE_VERSION,
  [string]$ApiHash = $env:API_REVIEW_API_HASH,
  [string]$APIViewUri = "https://apiview.dev/AutoReview/GetReviewStatus",
  [string]$APIViewApiKey = $env:APIVIEW_API_KEY
)

Set-StrictMode -Version 4
$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "../../..")).Path
. (Join-Path $repoRoot "eng/common/scripts/Helpers/ApiView-Helpers.ps1")

if (!$Language) {
  $Language = "python"
}
if (!$PackageName) {
  $PackageName = "azure-keyvault-keys"
}
if (!$PackageVersion) {
  $PackageVersion = "4.12.0b3"
}
if (!$ApiHash) {
  $ApiHash = "aef97d024f2a340bd992eff0001471606f8270c8d35a69635de9fb50152b9e01"
}

$apiApprovalStatus = [PSCustomObject]@{
  IsApproved = $false
  Details = ""
}
$packageNameStatus = [PSCustomObject]@{
  IsApproved = $false
  Details = ""
}

Check-ApiReviewStatus `
  -packageName $PackageName `
  -packageVersion $PackageVersion `
  -language $Language `
  -url $APIViewUri `
  -apiKey $APIViewApiKey `
  -apiApprovalStatus $apiApprovalStatus `
  -packageNameStatus $packageNameStatus `
  -apiHash $ApiHash

if (!$apiApprovalStatus.IsApproved)
{
  exit 1
}