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
- Historical dashboard-increment source count: **625,904 nonblank lines**, including comments/tests. Original: 33 files, 3,158 physical lines, 2,992 nonblank lines; attributed Besu: 4,484 files, 714,385 physical lines, 622,912 nonblank lines.
- Published source commit [`0171822ddd94ef1ef1abf3dd435fddb3578ff610`](https://github.com/samadalam481470sa-cmd/clearledger/commit/0171822ddd94ef1ef1abf3dd435fddb3578ff610), tree `59c36e84d3858591371f7d9a3c14fc24973d0e9d`, matched all reviewed staged bytes. Regular CI run [`40213554281`](https://github.com/samadalam481470sa-cmd/clearledger/actions/runs/40213554281), job `121229747000`, completed successfully: **96 passes, zero failures**, in 40,638.738634 ms, plus typecheck, Solidity/Vite build, and source count 625,904. Completed run conclusion, all job steps, and logs were verified.
- Backend/network configuration is unchanged; the earlier Besu workflow remains network evidence, with no additional Besu rerun claimed for this frontend increment. Browser-origin access remains denied, with no alternate route used. Layout, browser events, focus behavior, and accessibility remain unverified.

## Bounded quorum-loss acceptance — verified

- The two-validator-stop scenario passed real Docker acceptance on GitHub Actions Ubuntu after extending the diagnostic recovery bound. The first attempt's 120-second timeout is retained below as historical evidence.
- Sequence: stop validator 3 after validator 4, drain in-flight imports until two healthy equal latest heads agree/stabilize for eight seconds, submit a signed 37.5 dUSD authorization with payer nonce 1, and require it visible as pending on both live nodes.
- During a 20-second observation window, require successful probes with unchanged height/hash, null receipts, unchanged 125 dUSD recipient balance, payer nonce 1, one journal, and a broadcast record retaining the same transaction hash/raw signed bytes.
- Every observation probe must succeed; RPC unavailability is an error, not evidence of a consensus halt.
- Recovery restarts validator 3 with a 300-second polling bound, requires at least two blocks of progress/finalization once with two journals, 162.5 dUSD recipient balance, payer nonce 2, and zero reconciliation exceptions, then restarts validator 4 and checks all-four catch-up.
- Thirteen deterministic helper tests passed in 278.4717 ms; combined helper/configuration checks passed 15/15 in 725.2262 ms, and strict TypeScript checks passed. The helper uses a monotonic observation clock. These are not live-consensus evidence.
- Full local `npm test` passed **109 tests, 109 passes, zero failures, exit 0**, in 86,315.1641 ms. Strict typecheck passed after implementation. Historical quorum-loss source count: **626,199 nonblank lines**, including comments/tests; original 35 files/3,476 physical/3,287 nonblank, attributed Besu 4,484 files/714,385 physical/622,912 nonblank.
- Published source [`b529fc40f68903147c29bba8685db07183805c12`](https://github.com/samadalam481470sa-cmd/clearledger/commit/b529fc40f68903147c29bba8685db07183805c12), tree `bfc11e8cd2cafcc487458bcf67b07f57d1583cc0`, passed regular CI run [`40215923258`](https://github.com/samadalam481470sa-cmd/clearledger/actions/runs/40215923258), job `121236910105`: 109 passes/zero failures in 52,530.954236 ms, plus typecheck, Solidity/Vite build, and source count 626,199. Conclusion, all steps, and logs were verified.
- Extended Besu run [`40215923176`](https://github.com/samadalam481470sa-cmd/clearledger/actions/runs/40215923176), job `121236909792`, first passed four-node block-1 agreement, the 125 dUSD settlement at block 23, and one-stop progress 24→26. With only two validators active it held height/hash at 26 for 20,093.496795 ms across 20 successful observations; the pending 37.5 dUSD transaction stayed unjournaled, recipient balance 125 dUSD, and payer nonce 1.
- The first extended run failed to restore progress within its original 120-second recovery bound: all three restarted/active heads remained at 26, with escalating QBFT rounds and the restarted node's round timer about 30 seconds behind in diagnostic logs. This is not a full extension pass.
- The successful retry allows 300 seconds for recovery, based on restarted-node round-zero catch-up, exponential backoff, and rotating proposers. It is not a recovery SLO or guarantee. Strict no-quorum/same-hash/raw-byte/journal/balance/nonce assertions remained unchanged, with no experimental flags or coordinated restart.
- Published source [`d2dd93c794645ca621516d597f60d2f59a60fc09`](https://github.com/samadalam481470sa-cmd/clearledger/commit/d2dd93c794645ca621516d597f60d2f59a60fc09), tree `8eacaa281a5c57f73c92b4053d0307311e1c3e10`, passed both workflows. Run conclusions, all job steps, and logs were verified.
- Regular run [`40216704639`](https://github.com/samadalam481470sa-cmd/clearledger/actions/runs/40216704639), job `121239290769`, passed 109 tests/109 passes/zero failures in 38,070.346537 ms, plus typecheck, Solidity/Vite build, and source count 626,199.
- Network run [`40216704663`](https://github.com/samadalam481470sa-cmd/clearledger/actions/runs/40216704663), job `121239290629`, passed four-node agreement at 1, first settlement at 23, one-stop progress 24→26, then two healthy heads unchanged at 26 for 20,105.430764 ms across 20 successful samples. The 37.5 dUSD payment remained pending/unjournaled with balance 125 and payer nonce 1.
- Restoring validator 3 gave three agreeing heads at 28 and finalized the same pending hash/raw signed bytes at block 27 once: journals 2, payer nonce 2, recipient balance 162.5 dUSD, reconciliation exceptions 0. Restoring validator 4 gave four agreeing heads at 30. Whole scenario duration 237,137 ms is not a throughput or settlement-latency benchmark.
- Local Docker remains unavailable. The frontend build was not rerun locally for this network-only change; the new regular CI build passed remotely. Script budget remains ten minutes within the 15-minute workflow job, with cleanup tracking validators 3 and 4.
- Scope remains a bounded 20-second observation on one host, not malicious faults, arbitrary partitions, prolonged soak, independent hosts, or production readiness.

## Receipt-outage/restart check — verified locally and in regular CI

- Local evidence: 110/110 tests, zero failures, exit 0, 168,939.2818 ms; new case 66,914.8221 ms, outage 60,417 ms/56 observations, and 9+46 failed receipt calls. Typecheck passed. These local measurements are distinct from CI below.
- Published source [`e99c69b34ba2c24f152e02a13e76d8515d3b278b`](https://github.com/samadalam481470sa-cmd/clearledger/commit/e99c69b34ba2c24f152e02a13e76d8515d3b278b), tree `8c1a583ab7910ca85a862745541f30a5d190d39e`, passed [regular CI `40239735290`](https://github.com/samadalam481470sa-cmd/clearledger/actions/runs/40239735290), job `121308762940`: 110 tests/110 passes/zero failures in 119,596.450914 ms, plus typecheck, Solidity/Vite build, and count 626,487. Conclusion, every step, and logs were verified.
- The new CI case took 65,702.148243 ms and measured a **60,705 ms** outage/59 observations, with 10 ticks/failed receipt calls before OS termination and 48 after restart: 58 total failed receipt calls, excluding the pre-fault read. Retries were serialized IPC commands, with actual worker termination/new process, writable SQLite reopen, and separate parent read-only reopen.
- The first mined 125 dUSD transfer kept the same hash/raw bytes with no journal, while the second 7 dUSD intent already had a signed EIP-712 authorization but stayed queued without signed native transaction bytes or another allocated relayer nonce. Healing settled both once: balance 132 dUSD, journals 2, payer nonce 2, consecutive native nonces, one settled audit each, and reconciliation checked 2/exceptions 0.
- Test-only work changed no production behavior and ran no new Besu scenario; it is not an autonomous daemon, hours-long soak, production guarantee, or recovery SLO. Historical receipt-outage source count: **626,487 nonblank lines**: original 37 files/3,775 physical/3,575 nonblank; attributed Besu 4,484 files/714,385 physical/622,912 nonblank, including comments/tests.

## Graceful lifecycle ordering — verified locally and in Linux CI

- Fixed a resource-ordering race: immediate SIGINT cleanup could close SQLite/provider while a worker tick or RPC-awaited HTTP handler still had writes to perform. RPC mode also lacked SIGTERM handling.
- Worker ticks are serialized and stopping awaits the active tick. HTTP drain gates new requests with 503/connection close and waits for handler promises even after client disconnect; the shared idempotent 20-second shutdown closes resources only after worker/request/listener drains finish.
- Failed/timed-out drains do not initiate resource close later. Both entrypoints guard SIGINT/SIGTERM, exit naturally at 0 after success, or print a fixed diagnostic and exit 1 on failure. The cooperative timer does not preempt blocking JavaScript, cancel already-started closing, or make SIGKILL/Windows force-kill graceful.
- Sixteen targeted unit/real-HTTP checks passed in 510.9822 ms, including disconnected-client late writes, drain failures, late completions, and deadlines. The full local suite completed **127 cases: 126 passes, zero failures, one explicitly skipped POSIX signal test on Windows**, exit 0, in 156,786.1452 ms. Strict typecheck and the integrated Solidity/Vite build passed.
- Published source [`a263648d18c8528e14fab5077b1ce4193de72c50`](https://github.com/samadalam481470sa-cmd/clearledger/commit/a263648d18c8528e14fab5077b1ce4193de72c50), tree `54b24e8ee3c7b84e0f84ab717e708e68aaade2da`, passed [Linux CI `40242671396`](https://github.com/samadalam481470sa-cmd/clearledger/actions/runs/40242671396), job `121317645218`: **127 tests/127 passes/zero failures/zero skips** in 107,867.015198 ms, plus typecheck, Solidity/Vite build, and source count 627,090. Conclusion, every step, and logs were verified.
- The real-SIGTERM helper case passed in 400.36676 ms; the HTTP drain gate in 25.819801 ms and disconnected-client late SQLite write in 12.503595 ms. The helper kept SQLite open for a paused tick, then produced one late audit write, one resource close, and exit 0 after release. This is not full CLI signal E2E, a new Besu run, or daemon/production evidence. Current source count remains **627,090 nonblank lines**, including comments/tests: original 42 files/4,407 physical/4,178 nonblank; attributed Besu 4,484 files/714,385 physical/622,912 nonblank.

## Public source publication — October 25, 2026

- The user created and supplied [samadalam481470sa-cmd/clearledger](https://github.com/samadalam481470sa-cmd/clearledger). Repository ID `1432932875` was verified public, with administrative/push access for the connected account.
- All 6,785 reviewed tracked files were published on `main` in source commit [`762dd075d4b3dbe8d04a0e88fa24550818f734a7`](https://github.com/samadalam481470sa-cmd/clearledger/commit/762dd075d4b3dbe8d04a0e88fa24550818f734a7).
- The published content tree, `c947995d42108b239349568ff7def50ea4779f7c`, matched the entire reviewed local Git tree exactly, including 56 unique binary blobs across 66 binary paths. Contracts and the source-count report were also verified through the connector.
- `origin` points to this new repository. Local `main` was aligned to `origin/main` only after the identical-tree check; the original local build history is preserved on `local-build-history`.
- Root `.env`, `node_modules/`, `data/`, `dist/`, `artifacts/`, and `network/generated/` are not tracked. Continue excluding keys, tokens, databases, scratch files, cached tools, and logs from future publication.
- Initial push CI run [`40173477932`](https://github.com/samadalam481470sa-cmd/clearledger/actions/runs/40173477932) completed successfully for source head `762dd075d4b3dbe8d04a0e88fa24550818f734a7`. Job `121109103415` reported every step successful, including `npm ci`, typecheck, tests, build, and source counting. Both the completed run conclusion and connector job steps were checked.

## Remaining verification limits

- Browser appearance/interaction remains unverified because browser-origin access was denied. No alternate browser route was used. Publishing through the authorized GitHub connector did not verify the dashboard visually.
- Other failure timings, malicious/unapproved peers, arbitrary partitions, independent-host failures, prolonged-outage/soak tests, disk/power-failure behavior, automatic stuck-transaction management, production readiness, and distributed relayer coordination remain future work. The bounded two-stop single-host scenario does not establish these broader properties.
- Native Git credential availability is not established by connector publication. Do not inspect unrelated secrets or modify any unrelated repository.

## Resume

Read this file and `ROADMAP.md`. Implement and verify one useful increment, record evidence and limitations, and notify only for a meaningful milestone, failure, completion, or required action. Check the new repository's actual CI outcome when actionable. Commit or publish only to this task's ClearLedger repository, preserving upstream attribution and excluding runtime state.
