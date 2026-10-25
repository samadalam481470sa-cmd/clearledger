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
- Four-node Docker/Besu startup and failover: Docker unavailable on the initial host.
- Production, security audit, load/soak performance, and upstream Besu's own test suite.
- Remote GitHub Actions until a repository is published and its actual run succeeds.
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

## Reproduced source count

The latest October 25 count was 624,796 nonblank source lines, including comments and tests:

| Source | Files | Physical lines | Nonblank lines |
| --- | ---: | ---: | ---: |
| Original application | 25 | 1,983 | 1,884 |
| Attributed Besu snapshot | 4,484 | 714,385 | 622,912 |

The script's exclusions and methodology are recorded in `docs/source-count.json`; the size is not a claim of independently authored executable statements.

## Local tool behavior

Ganache warns about unavailable native µWS support on Node 24 and falls back to JavaScript transport. The tested chain uses memory-backed storage because the initial Windows sandbox prevented a temporary database rename.

The frontend build writes Vite output synchronously to avoid an observed asynchronous directory-creation issue in that sandbox. All generated output stays in this project.
