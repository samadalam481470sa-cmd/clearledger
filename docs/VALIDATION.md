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
- Docker/Besu operation on the original Windows host, additional failure timings, malicious peers, arbitrary partitions, and independent-host failures. The passing bounded two-stop GitHub Actions case is documented below.
- Production, security audit, load/soak performance, and upstream Besu's own test suite.
- Complete reorganization repair, full-chain event indexing, and multi-process relayer coordination.
- Browser verification of the paginated dashboard, including interactions and accessibility; model/API/server-rendered checks are described below.

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

## Store lifecycle invariant increment

Twenty-six targeted synthetic database tests passed in 521.598 ms, and strict TypeScript checking passed. They cover atomic lifecycle transition guards, unknown-payment rejection, exact-repeat no-ops without duplicate audits, conflicting reservation/finalization rejection, terminal rewrite rejection, and comparison of stored journal/provenance fields. Settled retries reject missing or inconsistent journals rather than hiding them behind an ignored duplicate insert. The intent lookup and insertion share a `BEGIN IMMEDIATE` transaction.

The full local `npm test` run also passed: **82 tests, 82 passes, zero failures, exit code 0**, in 86,524.5499 ms. Strict TypeScript checking passed. Store changes now trigger network acceptance as well as regular CI.

Published source commit [`5502af2cd86e17c7da185377e2d2fa3ed3a43c63`](https://github.com/samadalam481470sa-cmd/clearledger/commit/5502af2cd86e17c7da185377e2d2fa3ed3a43c63), public tree `8c6c1f5db6085def8ce41cab4a6755d33b772097`, passed both workflows. Completed conclusions, all job steps, and logs were verified:

- [Regular run `40190456973`](https://github.com/samadalam481470sa-cmd/clearledger/actions/runs/40190456973), job `121160152689`: 82 tests/82 passes/zero failures in 39,654.135943 ms, plus typecheck, Solidity/frontend build, and source count 625,249.
- [Besu run `40190456959`](https://github.com/samadalam481470sa-cmd/clearledger/actions/runs/40190456959), job `121160152352`: all four agreed at block 1 with heads `[1,1,1,1]`; signed 125 dUSD (`125000000` base units) settled at block 23 with one journal and zero reconciliation exceptions; the surviving three progressed from 24 to 26 while validator 4 was stopped; restart restored all-four agreement at height 28.

The settlement transaction was `0x8a782917255f6a265cb9b237d8f23af5b98f0540174791bf6522bf40e284bff5`. This complete scenario took 73,765 ms on a single GitHub Actions Ubuntu Docker host, not a throughput or settlement-latency benchmark.

The 26 targeted cases are local SQLite/application-invariant tests. They do not by themselves verify EVM execution, canonical receipts, tamper-proof storage, or multiworker operation. The combined suite runs existing EVM/recovery/transport tests, and the separate Besu workflow verifies the stated live-network scenario. Broader failure patterns, independent-host, malicious-peer, soak, browser, audit, and production limits remain; bounded two-stop evidence is recorded next.

## Bounded quorum-loss and recovery — verified

The implemented extension stops validators 4 and 3, drains in-flight blocks until two healthy equal latest heads agree and remain stable for eight seconds, and submits a signed 37.5 dUSD authorization at payer nonce 1. Both active nodes must see that transaction pending. A 20-second observation requires successful probes, unchanged height/hash, null receipts, broadcast state with identical hash/raw bytes, one journal, recipient balance 125 dUSD, and payer nonce 1. Restoring validator 3 now allows up to 300 seconds for recovery, requires at least two blocks of progress, and finalizes the same transaction once: two journals, recipient balance 162.5 dUSD, payer nonce 2, and zero reconciliation exceptions. Validator 4 then catches up.

Thirteen deterministic helper tests passed in 278.4717 ms; combined helper/configuration checks passed 15/15 in 725.2262 ms. The full local `npm test` run passed **109/109 tests**, zero failures, exit 0, in 86,315.1641 ms, and strict TypeScript checking passed after implementation. The helper's observation clock is monotonic. Deterministic tests validate observation logic rather than consensus; RPC failure must fail rather than masquerade as a halted chain.

Published source [`b529fc40f68903147c29bba8685db07183805c12`](https://github.com/samadalam481470sa-cmd/clearledger/commit/b529fc40f68903147c29bba8685db07183805c12), tree `bfc11e8cd2cafcc487458bcf67b07f57d1583cc0`, passed [regular CI run `40215923258`](https://github.com/samadalam481470sa-cmd/clearledger/actions/runs/40215923258), job `121236910105`: 109 passes/zero failures in 52,530.954236 ms, successful typecheck/Solidity/Vite build, and source count 626,199. The completed conclusion, all steps, and logs were verified.

The first [extended Besu run `40215923176`](https://github.com/samadalam481470sa-cmd/clearledger/actions/runs/40215923176), job `121236909792`, **failed in quorum restoration after passing the strict observation phase**:

- Initial four-node agreement was at block 1; 125 dUSD settled at block 23; one-validator-stop progress was 24→26.
- Two live nodes held the same height/hash at 26 for 20,093.496795 ms across 20 successful observations. The second payment had no receipt or new journal; recipient balance stayed 125 dUSD and payer nonce stayed 1.
- Pending transaction: `0xe54f289617b4d334b8cfebaef7c3b4d731f66df27cdf63f23e4454a339878ee9`.
- Restarting validator 3 did not restore progress within the original 120 seconds; the three active heads stayed at 26. Logs showed escalating QBFT rounds and a restarted-node round timer about 30 seconds behind. This failed attempt remains historical evidence, not the current result.

The subsequent change raises recovery polling to 300 seconds, justified by observed default QBFT round backoff/rotating proposer timing and a restarted node beginning at round zero. It is not a recovery SLO or guarantee. No strict observation/transaction/journal assertions were relaxed, and no experimental consensus flag or coordinated restart was introduced.

Published source [`d2dd93c794645ca621516d597f60d2f59a60fc09`](https://github.com/samadalam481470sa-cmd/clearledger/commit/d2dd93c794645ca621516d597f60d2f59a60fc09), tree `8eacaa281a5c57f73c92b4053d0307311e1c3e10`, passed both workflows. Completed conclusions, all job steps, and logs were verified:

- [Regular run `40216704639`](https://github.com/samadalam481470sa-cmd/clearledger/actions/runs/40216704639), job `121239290769`: 109 tests/109 passes/zero failures in 38,070.346537 ms, successful typecheck/Solidity/Vite build, and source count 626,199.
- [Network run `40216704663`](https://github.com/samadalam481470sa-cmd/clearledger/actions/runs/40216704663), job `121239290629`: the complete bounded scenario below succeeded on one Ubuntu Docker host.

| Phase | Observed result |
| --- | --- |
| Initial agreement/settlement | Four heads at 1; 125 dUSD at block 23; one journal |
| One stopped validator | Stop validator 4 at 24; three validators progress to 26 |
| Two stopped validators | Two healthy heads/hash remain at 26 for 20,105.430764 ms across 20 successful samples; pending payment has no receipt/journal, balance 125 dUSD, nonce 1 |
| Restore validator 3 | Three agreeing heads 28; the same pending transaction settles 37.5 dUSD (`37500000` base units) at block 27; journals 2, balance 162.5 dUSD, nonce 2, reconciliation exceptions 0 |
| Restore validator 4 | Four agreeing heads at 30/common hash |

First transaction: `0xa2727c183e70f779ebf2be8c12a3d058459a0c0988045bf11ee2069e0867addc`. Pending/recovered transaction: `0x88928bac116a2e9d328da8cfd9d04039ef2be4b8686087189b411292c69f7759`. Stored hash/raw bytes were required to remain identical through recovery. The whole scenario took 237,137 ms, not a throughput or settlement-latency benchmark.

The frontend build was not rerun locally for this network-only increment; the successful regular CI rebuilt it. Script budget remains ten minutes, job budget 15 minutes, and failure cleanup tracks both stopped validators. This verifies only the specified single-host bounded observation/recovery case.

The prior successful Docker scenarios above covered one stopped validator. The new case remains bounded to one host and a 20-second sampling window, without malicious-fault, arbitrary-partition, multi-host, soak, or production claims.

## Bounded receipt-outage/restart check — verified locally and in CI

- Local `npm test`: **110/110 passes**, zero failures, exit 0, 168,939.2818 ms; new case 66,914.8221 ms, measured outage 60,417 ms/56 observations, and 9+46 failed receipt calls. Strict typecheck passed.
- Source [`e99c69b34ba2c24f152e02a13e76d8515d3b278b`](https://github.com/samadalam481470sa-cmd/clearledger/commit/e99c69b34ba2c24f152e02a13e76d8515d3b278b), tree `8c1a583ab7910ca85a862745541f30a5d190d39e`, passed [regular CI `40239735290`](https://github.com/samadalam481470sa-cmd/clearledger/actions/runs/40239735290), job `121308762940`: 110 tests/110 passes/zero failures in 119,596.450914 ms, plus typecheck, Solidity/Vite build, and count 626,487. Completed conclusion, every job step, and logs were verified.
- The CI case took 65,702.148243 ms, with a **60,705 ms** real local-EVM HTTP receipt outage and 59 observations. Serialized IPC retries produced 10 ticks/failed receipt calls before the OS kill and 48 after restart—58 failed calls total, excluding the pre-fault read. The worker and parent read-only inspection connection reopened the file-backed SQLite database.
- During the outage the first mined 125 dUSD payment preserved identical hash/raw bytes and no journal. The second 7 dUSD intent already had its EIP-712 authorization but stayed queued without signed native transaction bytes or another allocated relayer nonce.
- Healing settled both once: recipient balance 132 dUSD, two journals, payer nonce 2, consecutive native transaction nonces, one settled audit per payment, and reconciliation checked 2 with zero exceptions.

This is one bounded local-EVM transport/process-recovery case, not an autonomous daemon, new Besu-network test, hours-long soak, or production availability claim. No production behavior changed; durations measure the test/outage, not a recovery SLO or throughput benchmark. The test-only increment did not rerun local frontend build; regular CI rebuilt it successfully.

## Graceful lifecycle ordering — verified locally and in Linux CI

- Sixteen targeted unit/real-HTTP checks passed in 510.9822 ms; strict typecheck passed. Checks include serialized worker stop, idempotent shutdown, failures/deadlines/late drain completions, and a disconnected client's late SQLite write completing before resource close.
- The change coordinates active worker, actual HTTP handler promises, and listener shutdown before closing shared resources; new requests receive 503/connection close. Both RPC/demo entrypoints guard SIGINT and SIGTERM through the shared default 20-second cooperative shutdown.
- Failed/timed-out drains do not trigger resource close later. Timers do not preempt blocking JavaScript or cancel already-started resource cleanup; force-kill remains crash recovery, not graceful termination.
- Full local `npm test` completed **127 cases: 126 passes, zero failures, one explicitly skipped POSIX signal-helper case on Windows**, exit 0, in 156,786.1452 ms. Strict typecheck and the integrated Solidity/Vite build passed.
- Source [`a263648d18c8528e14fab5077b1ce4193de72c50`](https://github.com/samadalam481470sa-cmd/clearledger/commit/a263648d18c8528e14fab5077b1ce4193de72c50), tree `54b24e8ee3c7b84e0f84ab717e708e68aaade2da`, passed [Linux CI `40242671396`](https://github.com/samadalam481470sa-cmd/clearledger/actions/runs/40242671396), job `121317645218`: **127 tests/127 passes/zero failures/zero skips** in 107,867.015198 ms, plus typecheck, Solidity/Vite build, and source count 627,090. Conclusion, every step, and logs were verified.
- The real-SIGTERM helper case passed in 400.36676 ms, HTTP drain gate in 25.819801 ms, and disconnected-client late SQLite write in 12.503595 ms. The helper kept SQLite open during a paused tick, then verified one late audit write, one resource close, and exit 0 after release. This is helper integration, not complete application CLI signal E2E; no new Besu run, daemon soak, exact exit deadline, or production guarantee is claimed.

## Reconciliation integrity

- Implemented validation covers stored payment/ID/transaction/block metadata, receipt identity/status, canonical block identity, every journal field, and matching configured-router settlement events. Hashes compare as bytes; unsafe SQLite block integers remain unchanged in storage and are invalid provenance.
- **64/64 targeted cases passed** in 14,914.0154 ms: 53 synthetic integrity cases plus 11 pagination cases. Strict typecheck and Solidity/Vite build passed.
- A real-EVM regression was added: corrupt the journal amount after genuine settlement, then require review with no reversal/resubmission or change in token balance/payer nonce. It passed in 1,520.2528 ms. The full local suite completed **181 cases: 180 passes, zero failures, one explicit POSIX skip on Windows**, exit 0, in 165,037.1639 ms. The synthetic checks alone are not EVM proof.
- Mismatches and missing receipt/block data retain the journal and flag review. RPC exceptions propagate without falsely reviewing the affected row; earlier mismatch decisions can remain committed before a later lookup fails. This is not independent RPC-proof verification or tamper-proof local storage.
- The source counter reports **627,385 nonblank lines**, including comments/tests: original 43 files/4,721 physical/4,473 nonblank and attributed Besu 4,484 files/714,385 physical/622,912 nonblank. Remote CI remains pending; the preceding 127-test CI evidence is historical.

## Public source verification — October 25, 2026

The project is public at [samadalam481470sa-cmd/clearledger](https://github.com/samadalam481470sa-cmd/clearledger). The user-created repository was verified as public with connected write access. Source commit [`762dd075d4b3dbe8d04a0e88fa24550818f734a7`](https://github.com/samadalam481470sa-cmd/clearledger/commit/762dd075d4b3dbe8d04a0e88fa24550818f734a7) contains all 6,785 reviewed tracked files.

Its content-addressed tree SHA, `c947995d42108b239349568ff7def50ea4779f7c`, exactly matches the reviewed local Git tree, including 56 unique binary blobs across 66 binary paths. Contracts and `docs/source-count.json` were additionally read back through the connector. Root runtime/dependency/generated-key directories and `.env` are untracked and were excluded from publication.

The initial [push workflow run 40173477932](https://github.com/samadalam481470sa-cmd/clearledger/actions/runs/40173477932) completed with conclusion **success** for source head `762dd075d4b3dbe8d04a0e88fa24550818f734a7`. Job `121109103415` reported all steps successful, including dependency installation (`npm ci`), strict TypeScript checks, tests, Solidity/frontend build, and source counting. The completed run conclusion and job-step results were verified separately. This is the first remote CI verification; it does not establish Docker/Besu operation, browser QA, production readiness, or a security audit.

## Dashboard collection and asset-volume increment

Fourteen targeted checks passed in 558.5743 ms: eleven controller/formatting tests, one real HTTP/API/controller integration, and two server-rendered presentation tests. The combined local suite passed **96 tests, 96 passes, zero failures**, exit 0, in 85,306.2986 ms. Strict TypeScript checking and the Solidity/Vite build passed after the final reconciliation-context fix.

Published source [`0171822ddd94ef1ef1abf3dd435fddb3578ff610`](https://github.com/samadalam481470sa-cmd/clearledger/commit/0171822ddd94ef1ef1abf3dd435fddb3578ff610), tree `59c36e84d3858591371f7d9a3c14fc24973d0e9d`, passed [regular CI run `40213554281`](https://github.com/samadalam481470sa-cmd/clearledger/actions/runs/40213554281), job `121229747000`. The completed run conclusion, every job step, and logs were verified: 96 tests/96 passes/zero failures in 40,638.738634 ms, successful typecheck and Solidity/Vite build, and source count 625,904.

Controller checks cover cursor history, failed navigation/retry, cancellation, obsolete successes/errors, disposal, malformed/cyclic pages, and uint256-scale formatting. The HTTP test uses 127 synthetic journaled projection records to traverse beyond overview's 100-row preview, retain an insertion boundary, retry authentication failure, and verify distinct asset totals. It is not an extra EVM settlement test. Presentation assertions preserve separate settled/review values and token-specific units without a browser.

The dashboard now uses independent 25-row payment and journal pages, separate per-asset volumes, explicit historical-page refresh behavior, and receipt snapshots. Metadata and page polling are serialized within their own loops, and obsolete contexts are discarded. A payment acknowledgement is reported before background reads; uncertain submission outcomes warn the user to inspect history before retrying. This does not give the demo endpoint a durable client idempotency key.

Browser-origin access remains denied. No alternative browser route was used, so layout, browser events, focus behavior, and accessibility remain unverified. The backend and network configuration were unchanged; the previous Besu workflow result remains the network evidence.

## Reproduced source count

The current reconciliation-increment source count is 627,385 nonblank source lines, including comments and tests:

| Source | Files | Physical lines | Nonblank lines |
| --- | ---: | ---: | ---: |
| Original application | 43 | 4,721 | 4,473 |
| Attributed Besu snapshot | 4,484 | 714,385 | 622,912 |

The script's exclusions and methodology are recorded in `docs/source-count.json`; the size is not a claim of independently authored executable statements.

## Local tool behavior

Ganache warns about unavailable native µWS support on Node 24 and falls back to JavaScript transport. The tested chain uses memory-backed storage because the initial Windows sandbox prevented a temporary database rename.

The frontend build writes Vite output synchronously to avoid an observed asynchronous directory-creation issue in that sandbox. All generated output stays in this project.
