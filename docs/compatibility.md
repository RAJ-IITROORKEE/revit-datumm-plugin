# Revit compatibility and verification

The supported installation range is Revit 2026, API file version 26.0.4.409 inclusive to 27.0.0.0 exclusive. The same release policy is embedded in the native DLL and consumed by installer preflight.

## Why the previous package failed

The former package required exactly API file version 26.4.0.32 in both setup and add-in startup. A valid 2026.5 installation reports 26.5.0.55, so it failed before connecting. Compiling only against 26.4 would also risk references unavailable to earlier 2026 installations.

The current native build targets .NET 8 against GA 2026 references: API file version 26.0.4.409, assembly identity 26.0.4.0. The release check inspects both RevitAPI/RevitAPIUI assembly references, the embedded compatibility policy and package metadata. It prevents publishing a later-API binary as an all-update 2026 package.

## Updates and runtime transition

Autodesk's [build table](https://www.autodesk.com/support/technical/article/caas/sfdcarticles/sfdcarticles/How-to-tie-the-Build-number-with-the-Revit-update.html) identifies 26.0.4.409 as first customer ship and 26.5.0.55 as Revit 2026.5.

Autodesk's [.NET transition guidance](https://help.autodesk.com/view/RVT/2025/ENU/?caas=caas/sfdcarticles/sfdcarticles/Revit--Requirements-for-products-affected-by-the-Microsoft--NET-10-transition.html) and [API migration discussion](https://forums.autodesk.com/t5/revit-api-forum/revit-2025-2026-migration-to-net-10-compatibility-and-deployment/m-p/14266522/highlight/true) describe the move to .NET 10 in Revit 2026.5. Targeting .NET 8 preserves older 2026 compatibility; Autodesk expects most .NET 8 add-ins to continue to work in .NET 10. This expectation requires testing for this particular add-in.

[Microsoft assembly loading rules](https://learn.microsoft.com/en-us/dotnet/core/dependency-loading/understanding-assemblyloadcontext) allow an equal or higher assembly version to satisfy a reference within a load context. This supports the same-year baseline strategy, but cannot guarantee Autodesk API semantics or third-party interactions.

## Validation scope

Release compilation and the native policy/assembly check are offline. Contract, authenticated C# transport and MCP tests simulate Revit callbacks. Installer tests exercise version bounds, ownership, integrity checks, rollback and removal using isolated directories. Packaged MCP smoke checks do not edit a model.

These checks do not establish live native behavior on 2026.5 or a clean client machine. Before production qualification, test launch, session discovery and a read-only document/catalog request on 2026.0 and 2026.5, then preview and separately approve a small edit in a disposable project, checking read-back and Undo. Do not use a production model for first write acceptance.

## Annual versions

Later annual Revit releases are deliberately refused by this package. Each annual target needs matching reference packages, the appropriate .NET target, matching year metadata and Addins registration, regression tests and actual Revit verification. Changing only the upper bound or copying the manifest into a different year's directory does not make a compatible plugin.
