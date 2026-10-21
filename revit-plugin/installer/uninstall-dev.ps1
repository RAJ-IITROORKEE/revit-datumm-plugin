[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
if (Get-Process Revit -ErrorAction SilentlyContinue) { throw 'Close Revit before uninstalling.' }
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$root = [IO.Path]::GetFullPath((Join-Path $env:APPDATA 'Autodesk/Revit/Addins/2026'))
$target = Join-Path $root 'DatummAgentDev'
$marker = Join-Path $target 'installation.json'
if (!(Test-Path -LiteralPath $marker)) { throw 'No managed DATUMM development installation found.' }
$metadata = Get-Content -LiteralPath $marker -Raw | ConvertFrom-Json
if ($metadata.owner -ne 'datumm-agent-dev' -or $metadata.repository -ne $repo) { throw 'Installation belongs to another checkout.' }
foreach ($name in @('Datumm.Revit.dll','Datumm.Bridge.dll','installation.json')) {
    $path = Join-Path $target $name
    if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path }
}
$manifest = Join-Path $root 'DatummAgentDev.addin'
if (Test-Path -LiteralPath $manifest) { Remove-Item -LiteralPath $manifest }
if (@(Get-ChildItem -LiteralPath $target -Force).Count -eq 0) { Remove-Item -LiteralPath $target }
Write-Output 'Removed the managed development add-in. Other add-ins and user configuration were preserved.'
