[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$version = 'v24.21.0'
$expected = '158f7685b44de51f6c0df1d153526cbcd3e1bc739a8dfc607721cef75de9e541'
$directory = Join-Path $repo 'artifacts/toolchain'
$name = "node-$version-win-x64.zip"
$archive = Join-Path $directory $name
New-Item -ItemType Directory -Force -Path $directory | Out-Null
if (!(Test-Path -LiteralPath $archive)) {
    Invoke-WebRequest "https://nodejs.org/dist/$version/$name" -UseBasicParsing -OutFile $archive
}
if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expected) {
    throw 'Node archive checksum mismatch. Remove the invalid archive and rerun setup.'
}
Expand-Archive -LiteralPath $archive -DestinationPath $directory -Force
Write-Output "Verified portable Node $version in artifacts/toolchain/node-$version-win-x64; the system Node installation is unchanged."
