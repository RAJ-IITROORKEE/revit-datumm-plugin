# Optional hosted connector

This Node process connects an authenticated hosted DATUMM device session to the local stdio MCP server over an outbound WebSocket. It does not expose Revit's loopback listener to the internet. The hosted service and desktop UI are separate products, not included here.

After the native package is installed, use Revit's DATUMM Connect / Settings panel or authorize from the repository root:

```powershell
node apps/connector/src/index.mjs --url=https://YOUR-ORCHESTRATOR --authorize
```

Sign in and authorize your own computer. Subsequent starts omit `--authorize`. HTTPS is required except for loopback development. Device credentials have current-user ACLs under `%LOCALAPPDATA%/DatummAgent/connector/device.json`; do not share them. Revoke a device in the dashboard and stop the connector to disconnect it.

The installed MCP entry is discovered from the managed installation record. `DATUMM_MCP_ENTRY` is a development override. Capabilities advertised to a hosted orchestrator do not bypass native approval or grant arbitrary execution. Connector regression tests use simulated transports; run `npm run test:connector` from the root.
