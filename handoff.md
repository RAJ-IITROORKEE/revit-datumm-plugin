# Bridge compatibility checkpoint

This standalone repository exports the current native DATUMM bridge/MCP source and fixes the exact Revit 2026.4 gate for the 2026 update family. Original desktop and native working checkouts remain untouched.

Product candidate: 0.5.0-alpha.29; component: 0.2.0-alpha.8. This candidate adds explicit Revit ribbon connection states while retaining the existing bridge behavior. Build-only GA API references are locked to Nice3point.Revit.Api.RevitAPI/RevitAPIUI 2026.0.4. The native binary embeds release.json; setup and startup use the GA file-version floor and next annual boundary. Packaging verifies actual compiled references before shipping. No Autodesk API DLL is distributed.

Use the commands in README.md to reproduce compilation and offline verification. `docs/provenance/source-export.json` describes exported source before compatibility edits. Release notes record completed checks and artifact identity.

Alpha.29 worktree verification on 2026-10-24 passed with Node **24.21.0**: plugin and MCP builds, connection-status and contract checks, Revit compatibility, MCP tests (54/54), connector tests (19/19), installer tests (9/9), and `npm audit` (0 vulnerabilities). No installer was produced; packaging requires a committed, reviewed HEAD. The source-export manifest remains the original baseline because this checkout has no source-export generator; candidate changes are visible in the Git diff.

Live 2026.5 launch, clean-machine installation and approved disposable-model edit acceptance remain open. No Revit process/model was closed, no bridge was installed locally, and no native model writes were made for this checkpoint. Future annual releases and a unified desktop/Revit installer remain separate work.
