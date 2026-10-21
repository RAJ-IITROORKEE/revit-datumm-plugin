# DATUMM wire contracts

Versioned JSON schemas describe native changes, model inspection, design briefs, plan graphs and the optional hosted task protocol. Schemas do not authorize native model changes.

`phase1.schema.json` covers session health and document context. `native-drafting.v2.schema.json` and `native-drafting.v3.schema.json` describe bounded native operations; schema 3 includes existing room color scheme assignment. Runtime preflight additionally checks actual Revit objects, document/revision, approval and transaction read-back.

The `design-brief` and `plan-graph` versions are used by MCP plan validation and compilation. Inputs retain explicit units, measured catalog bindings, geometry identity and supported-version constraints. A concept graph requires a live native catalog and reviewed preview before applying changes.

Brief extraction, interpretation, evidence coverage and task schemas are retained for optional hosted integration. Their hosted validators and persistence services are outside this repository. Build and offline checks are documented in the [root README](../README.md); native compatibility and live acceptance limits are in [compatibility.md](../docs/compatibility.md).
