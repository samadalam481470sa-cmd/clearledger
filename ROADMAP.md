# ClearLedger roadmap

Prioritize verified payment correctness and demonstrable engineering over source size.

## Next increments

1. Extend controlled HTTP-proxy coverage into prolonged outage/recovery and soak tests; short 503/drop/timeout failures, lost broadcast responses, library-level ambiguous failures, and process interruption are already tested.
2. Extend the passing single-host Docker acceptance scenario to loss of two validators, hostile peers, and independent-host failures.
3. Adopt the implemented paginated payment/journal APIs and per-asset transfer-volume totals in the dashboard; its current view still assumes the demo asset and recent 100 records.
4. Add a durable event indexer with checkpoints, canonical-block validation, and controlled replay.
5. Design journal reversal/rebuild for reorganization recovery while preserving the audit trail.
6. Verify dashboard interaction and accessibility after browser access is available.

## Advanced application work

- Replace the legacy development EVM with a maintained Cancun-compatible runner.
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
- Store lifecycle: all 82 local tests passed (zero failures, exit 0, 86,524.5499 ms), including 26 new synthetic SQLite cases for atomic transition guards, exact-repeat audit no-ops, conflict/terminal rewrite rejection, journal/provenance checks, and transaction-scoped acceptance lookup. Typecheck passed. Source count is 625,249 nonblank lines (2,337 original and 622,912 upstream, including comments/tests). CI is pending publication, with Store changes now triggering network acceptance. These invariants do not add multiworker support or tamper-proof storage.
