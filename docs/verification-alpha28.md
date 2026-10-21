# Alpha.28 offline release verification

Unsigned product 0.5.0-alpha.28 / component 0.2.0-alpha.8 was built from native source commit ee5bd8b371ca0c8c242eb96555ae67af8baac0f7. The following documentation and smoke-test-only follow-up does not alter shipped payload files.

| Check | Result |
| --- | --- |
| Release native compilation with locked GA API references | Passed; zero warnings/errors |
| Actual compiled RevitAPI/RevitAPIUI references and embedded release policy | Passed; assembly 26.0.4.0, file baseline 26.0.4.409 |
| GA, older/wrong annual versions, malformed versions, 2026.5 and later 2026 policy cases | Passed |
| C# geometry, ownership, hashes, durable journals and request correlation | Passed offline |
| MCP validation, geometry and authenticated production transport with simulated Revit | 54 tests passed |
| Installer compatibility, integrity, rollback, ownership and removal | 9 tests passed |
| Optional connector recovery and exact receipt preservation | 19 tests passed |
| Production npm advisory inventory | Zero reported vulnerabilities at build time |
| Staged runtime dependency resolution, actual MCP handshake and connector pairing gate | Passed |
| Complete staged manifest integrity | 4,409 files verified |
| Packaged MCP launched with System32-only PATH and isolated session directory | Passed; 18 tools, no developer runtime on PATH |
| Packaged variable modules and representative general program search | Passed |

Artifact: `DatummAgent-0.5.0-alpha.28-unsigned-win-x64.exe`, 27,370,227 bytes. SHA256: `8c0fff0131edec2100e9f6b586899b2ef4e28d487e8884d1c2d3464099f86e67`.

The artifact is not signed. Live native startup on 2026.5, clean-machine install/upgrade, actual disposable-model reads/writes and annual Revit 2027+ qualification were not performed. No running Revit process or model was closed and the local installed bridge was not replaced. See [compatibility](compatibility.md) before claiming production acceptance.
