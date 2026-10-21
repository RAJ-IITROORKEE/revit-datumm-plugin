# Bridge compatibility checkpoint

This standalone repository exports the current native DATUMM bridge/MCP source and fixes the exact Revit 2026.4 gate for the 2026 update family. Original desktop and native working checkouts remain untouched.

Product candidate: 0.5.0-alpha.28; component: 0.2.0-alpha.8. Build-only GA API references are locked to Nice3point.Revit.Api.RevitAPI/RevitAPIUI 2026.0.4. The native binary embeds release.json; setup and startup use the GA file-version floor and next annual boundary. Packaging verifies actual compiled references before shipping. No Autodesk API DLL is distributed.

Use the commands in README.md to reproduce compilation and offline verification. `docs/provenance/source-export.json` describes exported source before compatibility edits. Release notes record completed checks and artifact identity.

Live 2026.5 launch, clean-machine installation and approved disposable-model edit acceptance remain open. No Revit process/model was closed, no bridge was installed locally, and no native model writes were made for this checkpoint. Future annual releases and a unified desktop/Revit installer remain separate work.
