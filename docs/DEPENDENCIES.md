# Dependency maintenance

Snapshot: October 26, 2026, for dependency-maintenance source `71677da01dbf7603d3c7b2cff209471736052970`. The subsequent ERC-1271 increment changes the router ABI/bytecode; artifact hashes here apply to this earlier source version. Versions and integrity hashes are pinned in `package.json` and `package-lock.json`. The [machine-readable audit record](dependency-audit.json) separates resolved findings from the legacy development tree still needing replacement.

| Package | Previous | Selected | Reason |
| --- | --- | --- | --- |
| Zod | 3.25.76 | 4.6.7 | Patched schema-validation release; application schemas and HTTP error handling are verified through the existing suite |
| Vite | 7.1.12 | 7.3.7 | Same-major patched build tool |
| solc → tmp | 0.0.33 | 0.2.7 override | Patched file helper while retaining the exact Solidity 0.8.30 compiler |

The [Zod advisory](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5) concerns oversized collection validation; ClearLedger uses strict object/string schemas and a 32 KiB HTTP body limit, so the audit entry alone did not establish an exploitable application path. Migration follows the [Zod 4 guide](https://zod.dev/v4/changelog). [Vite's advisory](https://github.com/vitejs/vite/security/advisories/GHSA-rq7h-c2jc-7f22) identifies 7.3.7 as a patched release. ClearLedger builds static assets and serves them through its loopback Node HTTP server; it has no Vite dev/preview command or React Server Components route.

The compiler is retained because both contracts pin `pragma solidity 0.8.30`. The scoped `solc` override selects `tmp` 0.2.7, covering the [type-confusion advisory affecting 0.2.6](https://github.com/advisories/GHSA-7c78-jf6q-g5cm) as well as older file-helper findings. A local `fileSync` create/write/read/cleanup smoke check passed inside task-owned scratch space. Recompilation produced identical complete artifact hashes for both contracts, including ABI, bytecode and compiler metadata; hashes are in the JSON record. The application's compiler path does not invoke an external SMT solver, and this check is not full SMT integration testing.

## Audit results and limits

`npm audit --json` fell from **37 to 33 affected package entries**: 1 low, 5 moderate, 22 high, 5 critical remain. Every remaining location in this checked lockfile belongs to Ganache or its bundled development subtree. Ganache is used by the local test-asset demo and EVM tests. Replacing it remains necessary maintenance work; no clean dependency-security claim is made.

`npm audit --omit=dev --json` still reports **27 entries** because Ganache's bundled/extraneous lock entries lack normal development classification. This output must not be presented as a verified RPC-runtime exposure inventory. `npm ls --omit=dev --all` distinguishes the declared runtime dependency tree; neither command proves absence of exploitable behavior.

Reproduce from the locked project with `npm ci`, `npm audit --json`, `npm audit --omit=dev --json`, and `npm ls --omit=dev --all`. Audit commands currently exit 1 because findings remain. Counts can change when advisory data changes. The network workflow now runs when either dependency manifest changes, so compatibility is checked against a fresh dependency install.

Strict TypeScript checking and the Solidity/Vite build passed locally. The final locked dependency set completed 230 local cases: 229 passes, zero failures, one explicit POSIX skip on Windows, in 194,907.9415 ms. The published dependency set passed [regular CI](https://github.com/samadalam481470sa-cmd/clearledger/actions/runs/40281421049) with all 230 tests, zero skips/failures, fresh install, typecheck/build/count, and [Besu settlement/recovery acceptance](https://github.com/samadalam481470sa-cmd/clearledger/actions/runs/40281420917) on the same source. The install log independently reported 33 audit entries. See [validation](VALIDATION.md#dependency-maintenance) for completed evidence. Browser interaction remains unverified.
