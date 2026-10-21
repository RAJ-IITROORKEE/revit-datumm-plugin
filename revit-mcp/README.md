# DATUMM Revit MCP

Component 0.2.0-alpha.8 is a local stdio MCP server using portable Node 24.21.0. It exposes 18 typed tools for authenticated Revit session discovery, inspection, view/selection actions, preview, approval, application and operation-status recovery.

`src/index.ts` registers tools. `bridge.ts` discovers current-user sessions and validates authenticated loopback transport. `drafting.ts` defines strict inputs and response contracts. Plan/layout modules compile bounded concepts using explicit measured native catalogs. `smoke.ts` is an opt-in live Revit read check; ordinary unit/transport tests simulate native callbacks.

Use the [root build and test commands](../README.md). Run `node revit-mcp/dist/index.js` for an MCP client or use the installer's generated config snippets. Stdout is reserved for MCP traffic. The native add-in must be enabled and a project open before document reads can succeed.

Models and names are untrusted data. Native reads require exact document/revision provenance where applicable. Writes still require a reviewed preview, exact approval and native validation. A timed-out write must be resolved through its existing operation ID; approval is not permission for arbitrary replay. See [compatibility and validation limits](../docs/compatibility.md).
