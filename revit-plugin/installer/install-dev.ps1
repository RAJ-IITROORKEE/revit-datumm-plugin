[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
if (Get-Process Revit -ErrorAction SilentlyContinue) { throw 'Close Revit before installing the development add-in.' }
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$release = Get-Content -Raw -LiteralPath (Join-Path $repo 'packaging/release.json') | ConvertFrom-Json
$yearText = [string]$release.revitCompatibility.year
if ($yearText -notmatch '^[0-9]{4}$') { throw 'Release Revit compatibility metadata is invalid.' }
$year = [int]$yearText
if ($year -lt 2000 -or $year -gt 2099) { throw 'Release Revit compatibility metadata is invalid.' }
$major = $year - 2000
$minimumText = [string]$release.revitCompatibility.minimumApiVersion
$maximumText = [string]$release.revitCompatibility.maximumApiVersionExclusive
$versionPattern = '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'
if ($minimumText -notmatch $versionPattern -or $maximumText -cne "$($major + 1).0.0.0") { throw 'Release Revit compatibility metadata is invalid.' }
try { $minimumApi = [version]$minimumText; $maximumApi = [version]$maximumText } catch { throw 'Release Revit compatibility metadata is invalid.' }
if ($minimumApi.Major -ne $major -or $minimumApi -ge $maximumApi) { throw 'Release Revit compatibility metadata is invalid.' }
$source = Join-Path $repo 'revit-plugin/src/Datumm.Revit/bin/Release/net8.0-windows'
$files = @('Datumm.Revit.dll', 'Datumm.Bridge.dll')
foreach ($file in $files) { if (!(Test-Path -LiteralPath (Join-Path $source $file))) { throw "Build output missing: $file" } }
$programFiles = [Environment]::GetFolderPath('ProgramFiles')
$apiPath = Join-Path $programFiles "Autodesk/Revit $year/RevitAPI.dll"
if (!(Test-Path -LiteralPath $apiPath -PathType Leaf)) { throw "Revit $year must be installed." }
$api = Get-Item -LiteralPath $apiPath
$apiVersionText = $api.VersionInfo.FileVersion
if ($apiVersionText -notmatch $versionPattern) { throw 'Installed Revit API version is malformed.' }
try { $apiVersion = [version]$apiVersionText } catch { throw 'Installed Revit API version is malformed.' }
if ($apiVersion -lt $minimumApi -or $apiVersion -ge $maximumApi) { throw "This build supports Revit $year API versions $minimumText up to but not including $maximumText." }
$root = [IO.Path]::GetFullPath((Join-Path $env:APPDATA "Autodesk/Revit/Addins/$year"))
$target = Join-Path $root 'DatummAgentDev'
$manifest = Join-Path $root 'DatummAgentDev.addin'
$marker = Join-Path $target 'installation.json'
$existing = Test-Path -LiteralPath $target
if ($existing -or (Test-Path -LiteralPath $manifest)) {
    if (!(Test-Path -LiteralPath $marker)) { throw 'Existing installation is not managed by this script; refusing to overwrite.' }
    $previous = Get-Content -LiteralPath $marker -Raw | ConvertFrom-Json
    if ($previous.owner -ne 'datumm-agent-dev' -or $previous.repository -ne $repo) { throw 'Installation belongs to a different checkout.' }
}
$backup = Join-Path $repo ('artifacts/install-backups/' + [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss-fff'))
New-Item -ItemType Directory -Force -Path $backup | Out-Null
$owned = $files + @('installation.json')
foreach ($file in $owned) {
    $old = Join-Path $target $file
    if (Test-Path -LiteralPath $old) { Copy-Item -LiteralPath $old -Destination (Join-Path $backup $file) }
}
if (Test-Path -LiteralPath $manifest) { Copy-Item -LiteralPath $manifest -Destination (Join-Path $backup 'DatummAgentDev.addin') }
try {
    New-Item -ItemType Directory -Force -Path $target | Out-Null
    foreach ($file in $files) { Copy-Item -LiteralPath (Join-Path $source $file) -Destination (Join-Path $target $file) -Force }
    $assembly = [Security.SecurityElement]::Escape((Join-Path $target 'Datumm.Revit.dll'))
    $xml = @"
<?xml version="1.0" encoding="utf-8"?>
<RevitAddIns>
  <AddIn Type="Application">
    <Name>DATUMM Agent Development</Name>
    <Assembly>$assembly</Assembly>
    <AddInId>F39C9CF1-DB15-47F7-AC4E-6B64F7CA0548</AddInId>
    <FullClassName>Datumm.Revit.Application</FullClassName>
    <VendorId>DATM</VendorId>
    <VendorDescription>DATUMM local read-only MCP bridge</VendorDescription>
  </AddIn>
</RevitAddIns>
"@
    [IO.File]::WriteAllText($manifest, $xml, [Text.UTF8Encoding]::new($false))
    $metadata = @{owner='datumm-agent-dev'; repository=$repo; version=$release.componentVersion; installedAt=[DateTime]::UtcNow.ToString('O'); files=$files}
    [IO.File]::WriteAllText($marker, ($metadata | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
} catch {
    # Restore only exact files owned by this installer. Never remove another add-in.
    foreach ($file in $owned) {
        $saved = Join-Path $backup $file
        $destination = Join-Path $target $file
        if (Test-Path -LiteralPath $saved) { Copy-Item -LiteralPath $saved -Destination $destination -Force }
        elseif (Test-Path -LiteralPath $destination) { Remove-Item -LiteralPath $destination }
    }
    $savedManifest = Join-Path $backup 'DatummAgentDev.addin'
    if (Test-Path -LiteralPath $savedManifest) { Copy-Item -LiteralPath $savedManifest -Destination $manifest -Force }
    elseif (Test-Path -LiteralPath $manifest) { Remove-Item -LiteralPath $manifest }
    throw
}
Write-Output "Installed unsigned development add-in: $manifest"
Write-Output 'Start Revit, load DATUMM if prompted, then open a project. Use the DATUMM ribbon button to disconnect.'
