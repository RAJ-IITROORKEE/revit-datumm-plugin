# DATUMM Revit add-in

Component 0.2.0-alpha.8 targets the Revit 2026 update family on Windows x64. It compiles against GA API file version 26.0.4.409 / assembly version 26.0.4.0 and .NET 8. The embedded release policy allows the GA build and later updates of the same annual version, including 2026.5. See [compatibility limits and evidence](../docs/compatibility.md).

`src/Datumm.Revit` owns Revit startup, ribbon connection/approval UI, the ExternalEvent dispatcher, native inspection and approved transactional changes. The ribbon reuses the embedded DATUMM mark and shows connected, disconnected, connecting, revoked, unavailable or disabled state on its existing button; the tooltip keeps the bridge toggle action, local and hosted states, and approval warning. `src/Datumm.Bridge` owns transport, sessions, DTOs, journaling and compatibility without an Autodesk dependency. `tests/Datumm.Bridge.TestHost` uses the real transport with simulated API callbacks; it is not Revit.

All Revit API access runs through ExternalEvent. Writes require preview and exact approval, document/revision checks, bounded operations and native read-back. Unknown write outcomes require querying the existing operation ID rather than blindly retrying. There is no save/sync or arbitrary code tool.

Build and run checks using the [root instructions](../README.md). Build-only NuGet reference packages are locked; Autodesk DLLs are excluded from output and packages. Explicit `RevitInstallDir` overrides are development-only and do not automatically qualify a release.

Close Revit before running `installer/install-dev.ps1`; start it again and allow DATUMM if prompted. `installer/uninstall-dev.ps1` removes only this checkout's managed development add-in. Client testing should use the packaged installer. No local model or loaded add-in is replaced by the build/test commands.

Session credentials are current-user only. Startup logs contain exception type/HResult under `%LOCALAPPDATA%/DatummAgent/startup.log`; dispatcher diagnostics are bounded and exclude request arguments and credentials. Never attach credential files to bug reports.
