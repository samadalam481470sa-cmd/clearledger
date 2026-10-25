# Validation evidence

Initial build: October 24, 2026, Windows, Node.js 24.22.1. Follow-up work is recorded in `STATUS.md`.

## Initial successful checks

- Strict TypeScript checking.
- DemoUSD and SettlementRouter compilation with Solidity 0.8.30, optimizer enabled, Paris EVM target.
- EVM/API integration tests covering successful settlement, retry idempotency, altered instructions, signature/domain separation, nonce reuse, roles, account restrictions, pauses, spending limits, day rollover, allowance revocation, supply caps, malformed integers, worker recovery, response loss, confirmation depth, rollback detection, concurrency, conservation, and HTTP boundaries.
- React/Vite production bundle generation.
- Local demo startup with deployed contracts and three seeded on-chain payments.
- Reproducible source count; the attributed Besu snapshot alone exceeds 100,000 nonblank source lines.

The initial suite passed 30 tests. The combined suite on October 25, 2026 passed **38/38 tests** in 34,376 ms. `npm run typecheck` and `npm run build` also passed, including Solidity compilation and the React/Vite bundle.

## Unverified paths

- Browser rendering, accessibility, and interaction: browser-origin access was denied by the approval gate. No alternate browser route was used.
- Docker/Besu operation on the original Windows host, two-validator loss, hostile peers, and independent-host failures. The passing GitHub Actions single-host scenario is documented below.
- Production, security audit, load/soak performance, and upstream Besu's own test suite.
- Complete reorganization repair, full-chain event indexing, and multi-process relayer coordination.
- Frontend adoption of paginated APIs and per-asset totals; the dashboard remains a recent-record demo-currency view.

## File-backed recovery increment — October 25, 2026

Eight targeted recovery tests passed on Windows with Node.js 24.22.1. They use file-backed SQLite and a real child worker terminated through the operating system, without JavaScript cleanup, at these checkpoints:

- Signed bytes committed before first broadcast.
- Broadcast completed before receipt finalization.
- Journal finalization committed before worker exit.
- A SQLite status/audit transaction left uncommitted.

After reopening the database, recovery preserves the transaction hash and produces one token transfer and one journal row. Further tests verify persisted-broadcast nonce priority despite clock rollback, retry after an ambiguous RPC call exception, atomic failure-status/audit rollback, and atomic journal/status rollback with a subsequent retry.

Strict TypeScript checks, compilation/frontend build, and all 38 tests in the combined suite passed for this increment.

The recovery-suite RPC exception check injects a library-level failure. Real HTTP transport tests were added separately below. Prolonged unavailability, disk/power-failure testing, and distributed-worker recovery remain future work.

## Controlled HTTP-outage increment — October 25, 2026

Five targeted tests passed against a real local HTTP proxy in 15,589 ms, with strict TypeScript checks also passing. The proxy forwards to the local EVM and deliberately injects these transport behaviors:

- Repeated 503 responses or dropped connections before preflight: the intent stays queued and settles after recovery.
- A silent HTTP exchange: the configured transport timeout releases the request rather than waiting indefinitely.
- Upstream acceptance of a raw transaction followed by a lost response: the original hash is recovered and the transfer settles once.
- A 503 during receipt lookup: the unresolved broadcast prevents allocating a nonce to the next payment until recovery.

Tests use a 2,000 ms timeout. The RPC-mode provider defaults to 5,000 ms per HTTP exchange, configurable through `RPC_TIMEOUT_MS` from 1 through 60,000, and allows one transport attempt per exchange. A logical RPC operation may perform several HTTP exchanges; this does not establish an overall RPC-call deadline.

The expanded combined run passed **43/43 tests**, with zero failures and exit code 0, in 75,502.6651 ms. The latest `npm run typecheck` also passed. This transport-only increment did not rerun the frontend build; the previous successful Solidity/frontend build remains historical evidence. These controlled short failures are not a prolonged outage or soak test.

## Pagination and per-asset volume increment — October 25, 2026

Eleven targeted pagination/accounting tests passed in 8,875 ms, and the latest strict TypeScript checks passed. They cover bounded payment/journal keyset pages, cursor collection/status compatibility, malformed/duplicate/unknown query rejection, sanitized payment responses, exact per-asset transfer volume, separate review volume, and reconciliation across all settled pages rather than a recent-record cutoff.

The scan's upper insertion boundary excludes newer inserts from that scan, but changing statuses are not a transactionally frozen snapshot. Reconciliation materializes each page before RPC awaits and status updates. Overview now returns payment/journal previews of up to 100 each. No browser rendering or frontend adoption of the new collection APIs was verified.

The expanded combined `npm test` run passed **54/54 tests**, zero failures, exit code 0, in 57,485.5395 ms. Strict TypeScript checking passed. The UI was unchanged and the frontend build was not rerun for this increment.

## Network acceptance tooling increment

Two generator/configuration tests passed, checking generated cryptographic membership, enodes, identical per-node genesis copies, minimally encoded RLP round zero, newline-terminated permission TOML, and refusal to replace existing validator keys. Strict TypeScript checks passed, including `scripts/verify-network.ts`.

The acceptance script and dedicated Docker workflow verify four-node chain/membership/block agreement, an actual 125 dUSD signed settlement and reconciliation, continued progress after stopping validator 4, and catch-up after restart. Besu and the separate RPC gateway are pinned to verified Docker Hub digests. This complete scenario passed on GitHub Actions Ubuntu, not the original Windows host.

Regular CI run [`40188100516`](https://github.com/samadalam481470sa-cmd/clearledger/actions/runs/40188100516) passed **56 tests**, zero failures, build, and source counting. The subsequent secure ownership fix passed two local configuration tests and strict TypeScript checks again.

First Docker runtime run [`40188100502`](https://github.com/samadalam481470sa-cmd/clearledger/actions/runs/40188100502) failed before consensus checks: Besu's entrypoint dropped root to UID 1000 while mode-0600 keys were owned by runner UID 1001. The fix in commit [`9ca8f9280fa0bbf28b259e53f1e392e56d733de7`](https://github.com/samadalam481470sa-cmd/clearledger/commit/9ca8f9280fa0bbf28b259e53f1e392e56d733de7) matches the configured non-root container identity to host ownership, keeps config read-only/keys 0600, and supplies writable host-owned node-data binds.

Diagnostic run [`40188833778`](https://github.com/samadalam481470sa-cmd/clearledger/actions/runs/40188833778) observed matching produced validator blocks but exposed host RPC connection refusals on the internal-only network. A separate non-root, digest-pinned gateway resolved host access while retaining internal validators, restricted key permissions, read-only proxy config, and no gateway key mounts. Its PID/temporary/cache paths are all under `/tmp`.

### Successful real network evidence

Source head `0091aa306111e67855ccda6d08435e15aaae6e5a` passed [network run `40189385292`](https://github.com/samadalam481470sa-cmd/clearledger/actions/runs/40189385292), job `121156932986`, and [regular CI run `40189385293`](https://github.com/samadalam481470sa-cmd/clearledger/actions/runs/40189385293), job `121156932941`. Both completed with success, and their job-step results/logs were verified. Regular CI recorded 56 tests/56 passes/zero failures, successful typecheck/build, and a source count of 625,049 nonblank lines.

The actual Docker acceptance log recorded:

| Check | Observed result |
| --- | --- |
| Initial agreement | Common block 1/hash; all heads `[1,1,1,1]` |
| Signed settlement | 125 dUSD / `125000000` base units at block 23; one journal; zero reconciliation exceptions |
| One-validator stop | Validator 4 stopped at height 24; surviving three advanced to 26 and agreed |
| Restart | All four heads 28 with a common canonical block hash |

Settlement transaction: `0xee95153f7fac54ae81804ac6586160868935ade07dc54b032b5930f483d4dc02`. The entire scenario took 77,920 ms; that duration is not a throughput or settlement-latency benchmark. All five containers shared one Ubuntu runner. This verifies the scripted single-host case, not two-validator failure, hostile peers, independent-host failures, prolonged soak, production readiness, or browser QA.

## Public source verification — October 25, 2026

The project is public at [samadalam481470sa-cmd/clearledger](https://github.com/samadalam481470sa-cmd/clearledger). The user-created repository was verified as public with connected write access. Source commit [`762dd075d4b3dbe8d04a0e88fa24550818f734a7`](https://github.com/samadalam481470sa-cmd/clearledger/commit/762dd075d4b3dbe8d04a0e88fa24550818f734a7) contains all 6,785 reviewed tracked files.

Its content-addressed tree SHA, `c947995d42108b239349568ff7def50ea4779f7c`, exactly matches the reviewed local Git tree, including 56 unique binary blobs across 66 binary paths. Contracts and `docs/source-count.json` were additionally read back through the connector. Root runtime/dependency/generated-key directories and `.env` are untracked and were excluded from publication.

The initial [push workflow run 40173477932](https://github.com/samadalam481470sa-cmd/clearledger/actions/runs/40173477932) completed with conclusion **success** for source head `762dd075d4b3dbe8d04a0e88fa24550818f734a7`. Job `121109103415` reported all steps successful, including dependency installation (`npm ci`), strict TypeScript checks, tests, Solidity/frontend build, and source counting. The completed run conclusion and job-step results were verified separately. This is the first remote CI verification; it does not establish Docker/Besu operation, browser QA, production readiness, or a security audit.

## Reproduced source count

The current network-tooling source count is 625,049 nonblank source lines, including comments and tests:

| Source | Files | Physical lines | Nonblank lines |
| --- | ---: | ---: | ---: |
| Original application | 27 | 2,255 | 2,137 |
| Attributed Besu snapshot | 4,484 | 714,385 | 622,912 |

The script's exclusions and methodology are recorded in `docs/source-count.json`; the size is not a claim of independently authored executable statements.

## Local tool behavior

Ganache warns about unavailable native µWS support on Node 24 and falls back to JavaScript transport. The tested chain uses memory-backed storage because the initial Windows sandbox prevented a temporary database rename.

The frontend build writes Vite output synchronously to avoid an observed asynchronous directory-creation issue in that sandbox. All generated output stays in this project.
