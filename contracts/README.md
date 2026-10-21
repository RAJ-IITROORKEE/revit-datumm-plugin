# Shared contracts

## Phase 5 M02 interpretation

`brief-extraction.v2.schema.json` is the independent interpreter's forced tool
output; `interpreted-brief.v2.schema.json` is the strict persisted projection from
`brief_contracts.py`. Generate/check using `uv run --frozen python
generate_brief_schemas.py --check` from the orchestrator package. Source spans and
input digest are validated beyond JSON shape. Decimal conversions are strings to
preserve exact values; units and parcel/footprint scope may remain unknown.
There are at most 48 sources, 12 dimension pairs per source, 48 retained dimension
records and 512 evidence facts. Bounds reject rather than truncate constraints.
Only visible reversible assumptions may be defaulted. `nativeAuthority` is always
`none`; the record is separate from the existing geometry design-brief v1/v2 schemas.
The unchanged geometry engine still rejects 9144 mm edges until M05.
See [M02 evidence](../tests/integration/phase5-mvp/M02/README.md).

## Phase 5 M01 task protocol

M08 adds `refresh_exact_proposal`: the same exact identity fields as approval,
but it confers no write authority. It can refresh only an expired, unsubmitted
variable-plan base review with confirmed rehearsal journals, persisted initial
input and unchanged acceptance/placement. A fresh dry run and manual review are
required; uncertain/committed/annotation batches cannot enter this path.

`task-protocol.v2.schema.json` and `task-event.v2.schema.json` are generated from
`apps/orchestrator/task_contracts.py`. From that package run
`uv run --frozen python generate_task_schemas.py --check` to detect drift (omit
`--check` to regenerate). Commands are strict, bounded and versioned; owner,
idempotency key and expected task/plan versions are checked by `/v2/tasks`.
Plan acceptance and mode changes confer no native authority. Legacy plan/draft
references identify their original owned execution and exact fingerprint.
The v1 graph/native protocols and frozen approval hashes remain unchanged.
See [M01 compatibility and evidence](../tests/integration/phase5-mvp/M01/README.md).

Phase 1 implements `phase1.schema.json`: descriptor, health, document-context
and envelope definitions. TypeScript validates C# responses against this shared
schema in transport tests and live smoke checks. Protocol 1 only has body-free
GET endpoints: `/health` and `/document-context`.

Required headers: Authorization (Bearer token), X-Datumm-Protocol (1),
X-Datumm-Session (UUID), X-Operation-Id (UUID). Descriptors are private local
discovery data, never MCP results.

The following requirements apply to the future write-command contract:

Required command fields: protocolVersion, operationId, sessionId, documentId,
tool name, arguments, explicit units/coordinate frame, expected state and (for
writes) approval binding. Document identity must not rely on filename alone.

Required response fields: operationId, status, structured error, warnings,
created/changed element identifiers, verification and timing. Define queued,
running, succeeded, failed, cancelled and unknown outcomes explicitly.

Reject unknown versions and malformed payloads. Use deterministic proposal hashes
and idempotency keys. Preserve exactly the approved arguments. Do not call a
static geometry preview a successful Revit dry run.

Phase 5F introduces `plan-graph.v1.schema.json`, generated from the strict
`PlanGraphV1` model in `apps/orchestrator/plan_graph.py`. This is a conceptual
graph contract, not a Revit change set. Coordinates and areas are integer
millimetres and square millimetres in internal XY; north is positive Y. Every
room, wall and opening has a stable key. The model rejects unknown fields and
versions, duplicates, missing references, non-orthogonal walls, invalid bounds
and openings outside their host walls. A 256 KiB encoded graph limit applies.
The SHA-256 fingerprint hashes UTF-8 JSON with lexically sorted keys and no
insignificant spaces, omitting only `display` metadata. Integer geometry
requires no rounding; native feet conversion and area tolerances belong to the
later compiler contract. `tests/test_plan_graph.py` checks the fingerprint
against the pinned Node runtime. A graph is not buildable until an exact live
catalog, document/session/revision and dry-run proposal are bound.
`design-brief.v1.schema.json` defines the bounded user program and its
structured minimum areas/adjacencies. Brief versions and graph versions are
immutable owner-scoped records. A graph can be stored only if its provenance
names an existing brief version owned by the same account. Neither schema
exposes arbitrary code or a native write action.

`revit-mcp/src/plan-graph.ts` validates the graph again before preview or
compilation. It checks room tiling, exact wall ownership, opening hosts,
circulation width, the requested entrance and door reachability. The graph
still needs an installed Revit catalog and rollback preview before any write
proposal; this source-only compiler is not a registered tool route yet.
The bounded generator examines at most three dimension-dependent orthogonal
arrangements; it returns explicit diagnostics for infeasible layouts. Its
score is the corridor's percentage of footprint plus total relative clear-area
surplus above each minimum, lower first. Free-text preferences are not scored
until the later decision loop translates them into reviewable constraints.
