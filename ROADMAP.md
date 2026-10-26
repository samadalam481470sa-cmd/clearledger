# ClearLedger roadmap

Prioritize verified payment correctness and demonstrable engineering over source size.

## Next increments

1. Extend beyond the verified bounded receipt-outage/restart case toward longer outage/recovery and autonomous-worker soak tests; current IPC-driven retries do not establish daemon availability.
2. Extend the verified bounded two-validator-stop scenario to other failure timings, malicious peers, arbitrary partitions, and independent-host failures.
3. Add an explicit token-metadata registry before displaying decimal amounts for arbitrary RPC assets; the dashboard currently preserves their exact base units.
4. Add a durable event indexer with checkpoints, canonical-block validation, and controlled replay.
5. Design journal reversal/rebuild for reorganization recovery while preserving the audit trail.
6. Verify dashboard interaction and accessibility after browser access is available.

Shutdown drain ordering now passes Windows unit/HTTP verification and Linux real-SIGTERM helper integration. A complete application CLI signal test remains future work; graceful handling does not cover force-kill or blocked JavaScript.

## Advanced application work

- Review the dependency advisories reported by CI and replace the legacy development EVM with a maintained Cancun-compatible runner.
- Add ERC-1271 contract-wallet authorization with explicit revocation semantics.
- Add PostgreSQL-backed jobs and a relayer lease before allowing multiple workers.
- Add controlled fee replacement and stuck-nonce resolution with an audit trail.
- Introduce signer interfaces for KMS/HSM integrations without embedded secrets.
- Demonstrate multisignature governance and delayed role changes.
- Model issuance/redemption accounting and off-chain reserve attestations as explicit simulations.
- Add telemetry, failure injection, load testing, and measured results.

## Publication and maintenance

- Publish only to a new public repository created for this task; do not modify unrelated repositories.
- Exclude keys, tokens, databases, dependency installs, generated files, and scratch data.
- Run remote CI and record actual outcomes.
- Keep the verified Besu container digest pinned and review dependency advisories.
- Keep source counts reproducible and original/upstream attribution separate.

No paid infrastructure, real financial accounts, customer data, production keys, or funded-mainnet deployment is authorized.

## Verified increments

- October 25, 2026: eight new tests cover file-backed SQLite reopen after actual child-process termination around broadcast and finalization, interrupted transaction rollback, relayer nonce ordering across clock rollback, ambiguous RPC retry, and atomic state/audit/journal writes. The worker prioritizes persisted broadcasts and SQLite uses WAL with synchronous FULL. All 38 tests, strict TypeScript checking, and compilation/frontend build passed; results are recorded in `STATUS.md`.
- October 25, 2026: five new real HTTP-proxy tests cover short 503/drop/timeout failures, response loss after upstream transaction acceptance, and receipt-outage nonce blocking. RPC mode has a configurable per-HTTP-exchange timeout and one transport attempt. All 43 tests and strict TypeScript checking passed. This transport-only increment did not rerun the frontend build. Source count reached 624,465 nonblank lines, including 1,553 original and 622,912 attributed upstream lines; comments/tests are included.
- October 25, 2026: eleven new pagination/accounting tests cover bounded collection/filter-bound cursor pages, exact separate settled/review transfer volume by asset, and reconciliation across all settled pages. All 54 tests and strict TypeScript checking passed. Source count reached 624,796 nonblank lines, including 1,884 original and 622,912 attributed upstream lines; comments/tests are included. Frontend pagination/totals adoption remains future work.
- Network tooling: source head `0091aa306111e67855ccda6d08435e15aaae6e5a` passed regular CI (56 tests/typecheck/build/count) and real single-host GitHub Actions Ubuntu Docker acceptance. Four validators agreed, a signed 125 dUSD payment journaled/reconciled, three validators progressed while one stopped, and all four caught up after restart. Secure key ownership/internal validators and a separate non-root loopback gateway are retained. Source count is 625,049 nonblank lines (2,137 original and 622,912 upstream, including comments/tests). The 77,920 ms scenario duration is not a throughput benchmark; two-validator/hostile-peer/multi-host/soak validation remains future work.
- Store lifecycle: all 82 local tests passed, including 26 new synthetic SQLite cases for atomic transition guards, exact-repeat audit no-ops, conflict/terminal rewrite rejection, journal/provenance checks, and transaction-scoped acceptance lookup. Published source `5502af2cd86e17c7da185377e2d2fa3ed3a43c63` passed regular CI (82 tests/typecheck/build/count) and the separate live Besu settlement/one-validator-failure/recovery workflow. Source count is 625,249 nonblank lines (2,337 original and 622,912 upstream, including comments/tests). These invariants do not add multiworker support or tamper-proof storage; the network result remains a single-host scripted case.
- Dashboard collections: payment/journal cursor pages, separate per-asset settled/review volumes, exact RPC base units, obsolete-request guards, historical-page refresh controls, and receipt snapshots are implemented. Published source `0171822ddd94ef1ef1abf3dd435fddb3578ff610` passed regular CI run `40213554281` with all 96 tests, typecheck, build, and source counting, including 14 new model/HTTP/presentation checks. Source count is 625,904 nonblank lines (2,992 original, 622,912 attributed upstream, including comments/tests). Browser appearance/interaction remains unverified.

## Bounded quorum-loss verification

- Source `d2dd93c794645ca621516d597f60d2f59a60fc09` passed regular CI (109 tests/typecheck/build/count) and the complete live single-host QBFT extension. Two healthy nodes held height/hash unchanged over 20,105.430764 ms/20 successful samples; restoring quorum finalized the same pending 37.5 dUSD transaction once, with two journals, payer nonce 2, balance 162.5 dUSD, and zero reconciliation exceptions before all-four catch-up. The initial 120-second timeout remains historical; the successful run used a 300-second diagnostic allowance without relaxed safety assertions or consensus flags. Whole duration 237,137 ms is not a benchmark or recovery SLO. Source count remains 626,199 nonblank lines (3,287 original, 622,912 upstream, including comments/tests). Malicious faults, arbitrary partitions, independent hosts, and soak validation remain future work.

## Bounded receipt-outage verification

- Source `e99c69b34ba2c24f152e02a13e76d8515d3b278b` passed regular CI `40239735290` (110 tests/typecheck/build/count). The new case measured 60,705 ms/59 observations across an OS-killed/restarted worker and reopened SQLite file, with 10+48 failed receipt calls excluding the pre-fault read. Both payments settled once after recovery, preserving the first transaction and blocking native preparation of the second authorized intent during the outage. Source count is 626,487 nonblank lines (3,575 original, 622,912 upstream, including comments/tests). This test-only local-EVM result is not a new Besu run, daemon soak, production guarantee, or recovery SLO.

## Graceful lifecycle verification

- Source `a263648d18c8528e14fab5077b1ce4193de72c50` passed Linux CI `40242671396` with all 127 tests, zero skips/failures, typecheck, Solidity/Vite build, and source count 627,090. It includes actual SIGTERM helper integration, HTTP drain gating, and a disconnected client's late SQLite write before close. Windows separately passed 126 cases with one explicit POSIX skip. The shared default 20-second shutdown remains cooperative—not complete CLI signal E2E, force-kill support, a daemon soak, or a production guarantee. Counts include 4,178 original and 622,912 attributed upstream nonblank source lines, including comments/tests.

## Reconciliation integrity verification

- Implemented stored metadata, complete journal fields, receipt/canonical identity, and configured-router settlement-event checks. The 53 synthetic integrity and 11 pagination cases pass, along with typecheck and build; the full local suite completed 181 cases (180 passes, zero failures, one explicit Windows POSIX skip) in 165,037.1639 ms, including a new real-EVM journal-corruption regression. Source `4db63d57d16a4d750fd565f0fef11da23e4ab66e` passed regular CI `40266156639` with all 181 tests, zero skips/failures, typecheck/build/count, and Besu run `40266156756` with settlement, two-stop quorum loss, same-transaction recovery, and four-node catch-up. The source count is 627,385 nonblank lines, separated by authorship in validation. Review flags retain journal history without automatic reversal or replacement of trusted RPC data.
