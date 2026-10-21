[CmdletBinding()]
param()
$ErrorActionPreference='Stop'
$repo=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$release=Get-Content (Join-Path $repo 'packaging/release.json') -Raw | ConvertFrom-Json
$nodeRoot=Join-Path $repo 'artifacts/toolchain/node-v24.21.0-win-x64'
$node=Join-Path $nodeRoot 'node.exe'
$compiler='C:/Program Files (x86)/Inno Setup 6/ISCC.exe'
$compilerHash='A7472A35BE9CD63DA59E54C2622A0D8B048AB2EC85382E2B2D47A5A79DBF9BEF'
if((Get-FileHash $compiler -Algorithm SHA256).Hash -ne $compilerHash){throw 'Inno compiler differs from the recorded toolchain; review before updating the pin.'}
if((& $node --version) -ne $release.nodeVersion){throw 'Node runtime version mismatch.'}
foreach($file in @('revit-mcp/dist/index.js','revit-plugin/src/Datumm.Revit/bin/Release/net8.0-windows/Datumm.Revit.dll')){if(!(Test-Path (Join-Path $repo $file))){throw 'Build the monorepo first.'}}
& dotnet run --project (Join-Path $repo 'revit-plugin/tests/Datumm.Bridge.TestHost') -c Release -- --compatibility (Join-Path $repo 'revit-plugin/src/Datumm.Revit/bin/Release/net8.0-windows/Datumm.Revit.dll') (Join-Path $repo 'packaging/release.json')
if($LASTEXITCODE -ne 0){throw 'Compiled Revit API references do not match the release compatibility policy.'}
$run=[DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss-fff')
$work=Join-Path $repo "artifacts/package-work/$run"
$stage=Join-Path $work 'payload'
$npmStage=Join-Path $work 'npm'
New-Item -ItemType Directory -Force -Path $stage,(Join-Path $npmStage 'revit-mcp') | Out-Null
Copy-Item (Join-Path $repo 'package.json'),(Join-Path $repo 'package-lock.json') $npmStage
Copy-Item (Join-Path $repo 'revit-mcp/package.json') (Join-Path $npmStage 'revit-mcp')
New-Item -ItemType Directory -Force -Path (Join-Path $npmStage 'apps/connector') | Out-Null
Copy-Item (Join-Path $repo 'apps/connector/package.json') (Join-Path $npmStage 'apps/connector')
$previousPath=$env:PATH
try{
 $env:PATH=$nodeRoot+';'+$previousPath
 Push-Location $npmStage
 try{& (Join-Path $nodeRoot 'npm.cmd') ci --omit=dev --ignore-scripts;if($LASTEXITCODE -ne 0){throw 'Production dependency install failed.'}}finally{Pop-Location}
}finally{$env:PATH=$previousPath}
function Copy-Tree([string]$Source,[string]$Destination){
 New-Item -ItemType Directory -Force -Path $Destination | Out-Null
 foreach($item in Get-ChildItem -LiteralPath $Source -File -Recurse -Force){
  if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){continue}
  $relative=[IO.Path]::GetRelativePath($Source,$item.FullName)
  $dest=Join-Path $Destination $relative
  New-Item -ItemType Directory -Force -Path ([IO.Path]::GetDirectoryName($dest)) | Out-Null
  Copy-Item -LiteralPath $item.FullName -Destination $dest
 }
}
Copy-Tree (Join-Path $npmStage 'node_modules') (Join-Path $stage 'node_modules')
foreach($workspace in @('revit-mcp','apps/connector')){
 $dependencies=Join-Path $npmStage "$workspace/node_modules"
 if(Test-Path -LiteralPath $dependencies){Copy-Tree $dependencies (Join-Path $stage "$workspace/node_modules")}
}
Copy-Tree (Join-Path $repo 'apps/connector/src') (Join-Path $stage 'apps/connector/src')
Copy-Tree (Join-Path $repo 'fixtures/3bhk') (Join-Path $stage 'fixtures/3bhk')
Copy-Item (Join-Path $repo 'apps/connector/package.json') (Join-Path $stage 'apps/connector')
Copy-Tree (Join-Path $repo 'revit-mcp/dist') (Join-Path $stage 'revit-mcp/dist')
New-Item -ItemType Directory -Force -Path (Join-Path $stage 'contracts'),(Join-Path $stage 'runtime'),(Join-Path $stage 'plugin'),(Join-Path $stage 'licenses') | Out-Null
foreach($name in @('phase1.schema.json','native-drafting.v2.schema.json','native-drafting.v3.schema.json','design-brief.v1.schema.json','design-brief.v2.schema.json','plan-graph.v1.schema.json','plan-graph.v2.schema.json','design-brief.v3.schema.json','plan-graph.v3.schema.json','plan-graph.v4.schema.json')){
 Copy-Item (Join-Path $repo "contracts/$name") (Join-Path $stage 'contracts')
}
Copy-Item (Join-Path $repo 'revit-mcp/package.json') (Join-Path $stage 'revit-mcp')
& $node (Join-Path $PSScriptRoot 'verify-payload-runtime.mjs') $stage
if($LASTEXITCODE -ne 0){throw 'Release payload runtime dependency verification failed.'}
Copy-Item (Join-Path $nodeRoot 'node.exe') (Join-Path $stage 'runtime')
Copy-Item (Join-Path $nodeRoot 'LICENSE') (Join-Path $stage 'licenses/Node-LICENSE.txt')
Copy-Item (Join-Path ([IO.Path]::GetDirectoryName($compiler)) 'license.txt') (Join-Path $stage 'licenses/Inno-Setup-LICENSE.txt')
Copy-Item (Join-Path $repo 'THIRD_PARTY_NOTICES.md') (Join-Path $stage 'licenses')
Copy-Item (Join-Path $repo 'revit-plugin/src/Datumm.Revit/bin/Release/net8.0-windows/Datumm.Revit.dll'),(Join-Path $repo 'revit-plugin/src/Datumm.Revit/bin/Release/net8.0-windows/Datumm.Bridge.dll') (Join-Path $stage 'plugin')
foreach($name in @('setup.mjs','lifecycle.mjs','release.json','QUICKSTART.txt')){Copy-Item (Join-Path $repo "packaging/$name") $stage}
if(Get-ChildItem $stage -Recurse -File | Where-Object {$_.Name -like 'RevitAPI*'}){throw 'Autodesk assembly found in payload.'}
$entries=@(Get-ChildItem $stage -Recurse -File | Sort-Object FullName | ForEach-Object {@{path=[IO.Path]::GetRelativePath($stage,$_.FullName).Replace('\','/');size=$_.Length;sha256=(Get-FileHash $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()}})
$manifest=@{product=$release.product;version=$release.version;componentVersion=$release.componentVersion;revitApiVersion=$release.revitApiVersion;revitCompatibility=$release.revitCompatibility;nodeVersion=$release.nodeVersion;unsignedDevelopmentBuild=$true;files=$entries}
[IO.File]::WriteAllText((Join-Path $stage 'release-manifest.json'),($manifest|ConvertTo-Json -Depth 8))
& $compiler /Qp "/DPayload=$stage" "/DPackageVersion=$($release.version)" (Join-Path $repo 'packaging/datumm.iss')
if($LASTEXITCODE -ne 0){throw 'Installer compilation failed.'}
$exe=Join-Path $repo "artifacts/releases/DatummAgent-$($release.version)-unsigned-win-x64.exe"
$checksum=(Get-FileHash $exe -Algorithm SHA256).Hash.ToLowerInvariant()
[IO.File]::WriteAllText(($exe+'.sha256'),$checksum+'  '+[IO.Path]::GetFileName($exe)+"`n")
$record=@{version=$release.version;payload=$stage;installer=$exe;sha256=$checksum;compilerSha256=$compilerHash;files=$entries.Count;createdAt=[DateTime]::UtcNow.ToString('O');gitCommit=(& git -C $repo rev-parse HEAD)}
[IO.File]::WriteAllText((Join-Path $repo 'artifacts/releases/latest-build.json'),($record|ConvertTo-Json -Depth 5))
$record|ConvertTo-Json
