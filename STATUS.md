# ClearLedger status

Updated: October 25, 2026.

## Scope and constraints

- Build an advanced fintech/blockchain portfolio relevant to job applications.
- Exceed 100,000 source lines through licensed attributed upstream source, with separate original/upstream counts.
- Publish only to the new public repository created for this task: [samadalam481470sa-cmd/clearledger](https://github.com/samadalam481470sa-cmd/clearledger).
- Do not modify, move, delete, stage, or upload any user files or repositories that existed before this task.
- Scheduled follow-up work is authorized. Automation `improve-clearledger-fintech-portfolio` is active, with the persisted schedule currently every 30 minutes; this is not uninterrupted execution.

Project writes are confined to the new `outputs/clearledger/` directory and task-created scratch files under `../../work/`. There is no permission to edit other projects.

## Completed and verified

- Original Solidity contracts, TypeScript API/worker, SQLite transfer journal, React dashboard.
- EIP-712 authorization, payer nonces, replay protection, eligibility, limits, and pauses.
- Persist-before-broadcast flow and canonical receipt reconciliation.
- Initial suite: 30 passing EVM/API tests; strict TypeScript checks passed.
- Production frontend bundle and local demo startup with three seeded payments.
- Besu 26.10.1 source snapshot with upstream LICENSE and NOTICE retained; 622,912 nonblank upstream source lines including comments/tests.
- Four-validator generator, Compose definition, deployment script, and successful single-host Docker settlement/failure/recovery acceptance on GitHub Actions Ubuntu.
- Architecture, API, security, provenance, setup, and portfolio documentation.

## October 25 recovery increment

- Eight targeted recovery tests passed on Node.js 24.22.1/Windows with file-backed SQLite and actual child-process termination before broadcast, after broadcast, after finalization, and during an uncommitted SQLite transaction.
- Additional checks verify broadcast-first nonce ordering despite clock rollback, ambiguous RPC-call retry, atomic failed-status/audit rollback, and atomic journal finalization rollback/retry.
- SQLite now uses WAL with `synchronous=FULL`; status and audit changes commit atomically.
- Persisted broadcasts are recovered before queued work; insertion `rowid` preserves order without wall-clock ties.
- Missing/empty preflight revert data stays retryable rather than becoming an unproven terminal rejection.
- The combined `npm test` run passed **38/38 tests** in 34,376 ms. `npm run typecheck` and `npm run build` passed, including Solidity compilation and the React/Vite bundle.
- Last completed source count for this increment: **624,262 nonblank lines**, including comments/tests. Original application: 21 files, 1,427 physical lines, 1,350 nonblank lines. Besu: 4,484 files, 714,385 physical lines, 622,912 nonblank lines. The machine-readable report is `docs/source-count.json`.

## October 25 HTTP-transport increment

- Five targeted real HTTP-proxy tests passed in 15,589 ms; strict TypeScript checks passed.
- Repeated preflight 503/drop failures preserve queued work for retry, and silent HTTP exchanges stop at the configured timeout.
- If upstream accepts signed bytes but the broadcast response is lost, receipt recovery settles the same hash once.
- Receipt lookup failures preserve broadcast priority and block the next native-nonce allocation until recovery.
- RPC mode now uses `createRpcProvider`, with a default 5,000 ms timeout per HTTP exchange, `RPC_TIMEOUT_MS` range 1..60,000, and one HTTP transport attempt. This is not a total RPC-call deadline.
- The expanded combined `npm test` run passed **43/43 tests**, zero failures, exit code 0, in 75,502.6651 ms. The latest `npm run typecheck` passed. The frontend build was not rerun for this transport-only change; the previous build pass remains recorded above.
- Transport-increment source count: **624,465 nonblank lines**, including comments/tests. Original application: 24 files, 1,639 physical lines, 1,553 nonblank lines. Besu: 4,484 files, 714,385 physical lines, 622,912 nonblank lines.
- These are controlled short outages, not prolonged-soak evidence.

## October 25 pagination/accounting increment

- Eleven targeted pagination/accounting tests passed in 8,875 ms; strict TypeScript checks passed.
- `GET /api/payments` and `/api/journals` return `{items,nextCursor}` with default 50/max 100 rows, descending insertion order, and versioned cursors bound to collection/filter/initial insertion range.
- Malformed, incompatible, duplicate, and unknown pagination query metadata returns 400; public payment pages omit signatures/raw signed bytes/fingerprints.
- `GET /api/totals` reports exact journal-derived transfer volume per lowercase asset, with settled/review counts and base-unit strings separate. These totals are not wallet balances or reserves.
- Reconciliation now traverses all settled pages, materializing each page before RPC awaits and status updates. The insertion range is fixed for each scan, but status membership is not a transactional snapshot.
- Overview payment/journal previews are capped at 100 each. The frontend remains a recent demo-currency view and has not adopted these pagination/totals APIs.
- The expanded combined `npm test` run passed **54/54 tests**, zero failures, exit code 0, in 57,485.5395 ms. Strict TypeScript checking passed. The UI was unchanged and the frontend build was not rerun for this increment.
- Pagination-increment source count: **624,796 nonblank lines**, including comments/tests. Original application: 25 files, 1,983 physical lines, 1,884 nonblank lines. Besu: 4,484 files, 714,385 physical lines, 622,912 nonblank lines.

## Network acceptance tooling increment

- Two generator/configuration tests passed; strict TypeScript checks passed, including the new acceptance script.
- The exported generator fixes permission TOML newlines, gives every validator its own identical genesis copy/read-only mount, and retains cryptographically consistent membership/enodes and refusal to overwrite keys.
- Compose pins the verified Besu 26.10.1 image digest `sha256:47aa21463213abcddc5972bc79443e6806c1c7c68e8f36ed33222882fbad8752`, sets development JVM heap bounds, and keeps the four validators exclusively on an internal network.
- Static P2P host advertisements and `--nat-method=NONE` keep peer addressing consistent with the generated enodes.
- `npm run network:verify` checks four-node agreement, deploys contracts, settles/reconciles 125 test dUSD, stops only validator 4 to check three-node progress, and restarts it for catch-up. Operations and cleanup are bounded; generated keys are not logged.
- Regular CI run [`40188100516`](https://github.com/samadalam481470sa-cmd/clearledger/actions/runs/40188100516) passed all 56 tests, build, and source count. Local configuration tests and strict TypeScript checks also passed.
- First Docker runtime run [`40188100502`](https://github.com/samadalam481470sa-cmd/clearledger/actions/runs/40188100502) failed at startup because Besu dropped root to UID 1000 but runner-owned mode-0600 keys belonged to UID 1001.
- Secure ownership fix [`9ca8f9280fa0bbf28b259e53f1e392e56d733de7`](https://github.com/samadalam481470sa-cmd/clearledger/commit/9ca8f9280fa0bbf28b259e53f1e392e56d733de7) uses configurable non-root UID/GID matching the generating host user, read-only config, and host-owned writable node-data binds. Keys stay 0600. Two local configuration tests and typecheck passed again.
- Diagnostic run [`40188833778`](https://github.com/samadalam481470sa-cmd/clearledger/actions/runs/40188833778) confirmed matching produced blocks through height 39, while host RPC ports failed with connection refused on the internal-only validator network.
- Gateway fix [`50e5aeed10b7305f5ce04a5765385fa8873f5c76`](https://github.com/samadalam481470sa-cmd/clearledger/commit/50e5aeed10b7305f5ce04a5765385fa8873f5c76) retains isolated/non-root validators and adds one official digest-pinned non-root nginx gateway. It joins internal `settlement` and ordinary `rpc-access`, publishes host-loopback 8545–8548, mounts only read-only `network/rpc.conf`, and has no key mounts. The stack is four validators plus one gateway.
- Network-tooling source head `0091aa306111e67855ccda6d08435e15aaae6e5a` passed both workflows: [network run `40189385292`](https://github.com/samadalam481470sa-cmd/clearledger/actions/runs/40189385292), job `121156932986`, and [regular run `40189385293`](https://github.com/samadalam481470sa-cmd/clearledger/actions/runs/40189385293), job `121156932941`, including all 56 tests, typecheck, build, and source count. Run conclusions, job steps, and logs were verified; regular CI recorded 56 passes/zero failures and 625,049 nonblank source lines.
- Actual network evidence: all four agreed at block 1/heads `[1,1,1,1]`; signed 125 dUSD settled at block 23 with one journal and zero reconciliation exceptions; validator 4 stopped at height 24 while the surviving three advanced to 26 and agreed; all four caught up to height 28 after restart. The scenario took 77,920 ms, not a throughput benchmark.
- The passing scenario ran on one GitHub Actions Ubuntu Docker host. Local Docker remains unavailable on the original Windows host. The non-root gateway uses `/tmp` for every PID/temporary/cache path.
- Network-increment source count: **625,049 nonblank lines**, including comments/tests. Original: 27 files, 2,255 physical lines, 2,137 nonblank lines. Attributed Besu: 4,484 files, 714,385 physical lines, 622,912 nonblank lines.

## Store lifecycle invariant increment

- Twenty-six targeted synthetic database tests passed in 521.598 ms; strict TypeScript checks passed.
- Store mutations enforce explicit transitions: queued→broadcast, queued/broadcast→failed, broadcast/settled→review, and broadcast→settled. Invalid transitions and unknown rows raise `StateTransitionError` inside the write transaction.
- Exact repeated reservations/finalization/terminal details are no-ops without duplicate audit entries; conflicting repetitions and terminal rewrites are rejected.
- Finalization compares all existing journal fields with payment/transaction/block provenance. A settled retry with a missing or inconsistent journal is rejected, rather than silently using `INSERT OR IGNORE`.
- Existing-intent reads now share `BEGIN IMMEDIATE` with acceptance insertion/audit writes.
- Lifecycle-increment source count: **625,249 nonblank lines**, including comments/tests. Original: 28 files, 2,471 physical lines, 2,337 nonblank lines. Attributed Besu: 4,484 files, 714,385 physical lines, 622,912 nonblank lines.
- Full local `npm test` passed **82 tests, 82 passes, zero failures, exit code 0**, in 86,524.5499 ms. Strict TypeScript checks passed. `src/store.ts` changes now trigger the Besu network acceptance workflow.
- Published source commit [`5502af2cd86e17c7da185377e2d2fa3ed3a43c63`](https://github.com/samadalam481470sa-cmd/clearledger/commit/5502af2cd86e17c7da185377e2d2fa3ed3a43c63), public tree `8c6c1f5db6085def8ce41cab4a6755d33b772097`, passed both CI workflows. Conclusions, job steps, and logs were verified.
- Regular run [`40190456973`](https://github.com/samadalam481470sa-cmd/clearledger/actions/runs/40190456973), job `121160152689`, passed all **82 tests**, zero failures, in 39,654.135943 ms, plus strict typecheck, Solidity/Vite build, and source count 625,249.
- Besu run [`40190456959`](https://github.com/samadalam481470sa-cmd/clearledger/actions/runs/40190456959), job `121160152352`, passed four-node block-1 agreement, signed 125 dUSD settlement at block 23 with one journal/zero reconciliation exceptions, progress 24→26 while validator 4 stopped, and all-four catch-up at 28. Scenario duration was 73,765 ms, not a throughput benchmark, on one Ubuntu Docker host.
- The 26 targeted SQLite cases do not by themselves prove EVM behavior, immutable storage, or multiworker correctness. The combined suite includes existing EVM/recovery/transport tests, and the separate Besu rerun verified the scripted live-network case. Single-worker and other stated deployment limits remain.

## Dashboard collection and asset-volume increment

- Separate 25-row payment and journal pages use server cursors, status filtering for payments, retained history on failed navigation, and explicit return-to-latest controls. Auth/filter/chain/router changes discard obsolete page contexts. The newest pages refresh periodically; historical pages do not move during polling.
- Per-asset settled/review transfer volume comes from `/api/totals`. RPC and unknown assets show exact base-unit strings; six-decimal dUSD formatting is limited to the known local demo token. No cross-asset money amount or wallet balance is invented.
- Fourteen targeted model/API/server-rendered checks passed in 558.5743 ms. The real HTTP/controller test uses 127 synthetic journaled projection records to traverse beyond overview's 100-row preview, preserve a scan across a new insertion, retry authentication failure, and check separate exact asset totals. These are synthetic records, not extra on-chain settlements.
- Full local `npm test` passed **96 tests, 96 passes, zero failures**, exit 0, in 85,306.2986 ms. Strict typecheck and the Solidity/Vite build passed after the final UI reconciliation-context fix.
- Payment acknowledgements are reported before independent read refreshes. Uncertain payment outcomes warn users to check history; this does not add durable client idempotency to the demo signing endpoint. Receipt dialogs are explicitly timestamped snapshots. Reconciliation responses from a replaced network are labelled accordingly.
- Source count: **625,904 nonblank lines**, including comments/tests. Original: 33 files, 3,158 physical lines, 2,992 nonblank lines; attributed Besu: 4,484 files, 714,385 physical lines, 622,912 nonblank lines.
- Publication/new CI verification is pending. Backend/network configuration is unchanged; the earlier Besu workflow remains network evidence. Browser-origin access remains denied, with no alternate route used. Layout, browser events, focus behavior, and accessibility remain unverified.

## Public source publication — October 25, 2026

- The user created and supplied [samadalam481470sa-cmd/clearledger](https://github.com/samadalam481470sa-cmd/clearledger). Repository ID `1432932875` was verified public, with administrative/push access for the connected account.
- All 6,785 reviewed tracked files were published on `main` in source commit [`762dd075d4b3dbe8d04a0e88fa24550818f734a7`](https://github.com/samadalam481470sa-cmd/clearledger/commit/762dd075d4b3dbe8d04a0e88fa24550818f734a7).
- The published content tree, `c947995d42108b239349568ff7def50ea4779f7c`, matched the entire reviewed local Git tree exactly, including 56 unique binary blobs across 66 binary paths. Contracts and the source-count report were also verified through the connector.
- `origin` points to this new repository. Local `main` was aligned to `origin/main` only after the identical-tree check; the original local build history is preserved on `local-build-history`.
- Root `.env`, `node_modules/`, `data/`, `dist/`, `artifacts/`, and `network/generated/` are not tracked. Continue excluding keys, tokens, databases, scratch files, cached tools, and logs from future publication.
- Initial push CI run [`40173477932`](https://github.com/samadalam481470sa-cmd/clearledger/actions/runs/40173477932) completed successfully for source head `762dd075d4b3dbe8d04a0e88fa24550818f734a7`. Job `121109103415` reported every step successful, including `npm ci`, typecheck, tests, build, and source counting. Both the completed run conclusion and connector job steps were checked.

## Remaining verification limits

- Browser appearance/interaction remains unverified because browser-origin access was denied. No alternate browser route was used. Publishing through the authorized GitHub connector did not verify the dashboard visually.
- Loss of two validators, hostile/unapproved peers, independent-host failures, prolonged-outage/soak tests, disk/power-failure behavior, automatic stuck-transaction management, production readiness, and distributed relayer coordination remain future work. The passing one-validator scenario does not establish these properties.
- Native Git credential availability is not established by connector publication. Do not inspect unrelated secrets or modify any unrelated repository.

## Resume

Read this file and `ROADMAP.md`. Implement and verify one useful increment, record evidence and limitations, and notify only for a meaningful milestone, failure, completion, or required action. Check the new repository's actual CI outcome when actionable. Commit or publish only to this task's ClearLedger repository, preserving upstream attribution and excluding runtime state.
