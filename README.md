# DATUMM Revit plugin

Actual C# Revit add-in, local TypeScript MCP server, optional hosted connector, contracts and Windows installer source for DATUMM. This repository is exported from the current native project; it does not contain the desktop UI or hosted service.

## Compatibility

Product **0.5.0-alpha.29**, component **0.2.0-alpha.8**, Windows x64. The installer and add-in accept the Revit **2026** family from the original shipping build **26.0.4.409** through API versions below **27.0.0.0**, including **2026.5 / 26.5.0.55**. The add-in compiles against the original 2026 API, targeting .NET 8. It no longer requires exactly Revit 2026.4.

The compatibility policy permits later 2026 updates without repinning an exact patch. This is not a guarantee against future Autodesk changes. Annual versions such as Revit 2027 require their own API/runtime build and validation; this installer does not register for them. See [compatibility and validation](docs/compatibility.md).

## Install and connect

1. Install Revit 2026 with its Autodesk prerequisites. Close Revit yourself before installing or upgrading the bridge; the installer never closes models.
2. Download the unsigned Windows installer from [Releases](https://github.com/RAJ-IITROORKEE/revit-datumm-plugin/releases). Run it as the Windows user who runs Revit.
3. Start Revit, allow the DATUMM add-in when prompted, and open a project. The DATUMM Agent ribbon enables the authenticated local bridge automatically.
4. Open DATUMM desktop and check its Revit connection. Use DATUMM Agent → Connect / Settings for hosted-device authorization if your workflow uses the optional connector. Authentication is still required; installation does not authorize model edits.

The per-user manifest is `%APPDATA%\Autodesk\Revit\Addins\2026\DatummAgent.addin`. Runtime files live in `%LOCALAPPDATA%\Programs\DatummAgent`. Generated `mcp-config.json` and `mcp-config.toml` in that directory can also connect an MCP client. Do not share session/device credential files. The desktop app and hosted service are distributed separately.

## Build and test

Windows x64, .NET SDK **8.0.417** (pinned by `global.json`), PowerShell 7, Git and internet access are needed. Revit need not be installed to compile: build-only API reference packages are restored from NuGet. Autodesk binaries are never copied to the release.

Run from the repository root in PowerShell:

```powershell
pwsh -NoProfile -File scripts/setup-node.ps1
$env:PATH = (Join-Path $PWD 'artifacts/toolchain/node-v24.21.0-win-x64') + ';' + $env:PATH
npm ci --ignore-scripts
npm run build:plugin
npm run build:mcp
npm run test:compatibility
npm run test:contracts
npm run test:installer
npm run test:mcp
npm run test:connector
```

For an explicit local Autodesk reference directory, `dotnet build revit-plugin/src/Datumm.Revit -c Release -p:RevitInstallDir="C:/Program Files/Autodesk/Revit 2026"` is available for development. A build against a later API cannot pass the all-2026 release compatibility gate.

`pwsh -NoProfile -File scripts/package.ps1` produces the EXE and SHA256 file in `artifacts/releases`. It requires the exact Inno Setup 6 compiler hash recorded in the script, the portable Node runtime, built MCP and plugin, and a committed Git HEAD. Packaging checks the DLL API references against the declared baseline and verifies the staged MCP runtime. It does not install the bridge.

Development installation is separately available through `revit-plugin/installer/install-dev.ps1`; uninstall with the paired `uninstall-dev.ps1`. These scripts refuse to replace another checkout's managed development installation. Prefer the packaged installer for client testing.

## Source map

| Path | Purpose |
| --- | --- |
| `revit-plugin/src/Datumm.Revit` | Revit startup, ribbon, ExternalEvent dispatcher, native reads and approved transactions |
| `revit-plugin/src/Datumm.Bridge` | Authenticated loopback transport, sessions, contracts and compatibility parser |
| `revit-mcp` | Typed MCP stdio tools and bounded plan compilation |
| `apps/connector` | Optional outbound hosted-device connector; requires a separate service |
| `contracts`, `fixtures`, `tests` | Wire schemas, deterministic inputs and regression fixtures |
| `packaging`, `scripts` | Reversible Windows installation, runtime verification and release tooling |

Writes retain preview, exact approval, revision checks, rollback and native read-back. There is no arbitrary code execution tool. The startup log is `%LOCALAPPDATA%\DatummAgent\startup.log`; installer errors are in `%LOCALAPPDATA%\DatummAgent\installer.log`.

## Provenance

[Source export](docs/provenance/source-export.json) records the original native project revision and hashes, including existing uncommitted native work at export time. [Third-party notices](THIRD_PARTY_NOTICES.md) describe the locked dependencies and build-only Autodesk references. No project-wide redistribution license has been selected; public source visibility alone does not grant one. The installer is an unsigned development candidate.
