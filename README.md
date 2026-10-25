# ClearLedger

**Signed payments, on-chain settlement, and a reconciled transfer journal.**

[Public repository](https://github.com/samadalam481470sa-cmd/clearledger) · [![ClearLedger checks](https://github.com/samadalam481470sa-cmd/clearledger/actions/workflows/ci.yml/badge.svg)](https://github.com/samadalam481470sa-cmd/clearledger/actions/workflows/ci.yml)

ClearLedger is a fintech engineering portfolio prototype built on EVM infrastructure. Its original application combines Solidity payment controls, a TypeScript settlement worker, SQLite accounting records, and a React operations dashboard. An attributed **Besu 26.10.1 source snapshot** is included under `upstream/`.

Demo USD has no monetary value, reserves, or redemption promise. This project is unaudited and has no banking integration. The consensus implementation is Besu's work; ClearLedger's original contribution is the payment application and its integration, tests, and documentation.

## Run the local demo

Requires Node.js 24+ and npm. Docker and a wallet extension are unnecessary for this mode.

```sh
npm ci
npm run build
npm test
npm run demo
```

Open **http://127.0.0.1:4317**. The demo creates temporary wallets, starts a memory-backed EVM, deploys both contracts, provisions test currency, and submits three example payments. Use **New payment** for another signed transfer and **Reconcile** to compare journaled receipts with the chain. Demo state resets when the process stops.

On the original Windows workspace, `Start-ClearLedger.ps1` can use the Node runtime bundled with the desktop app. It requires installed project dependencies and does not change global software or shell profiles.

## Implemented behavior

- EIP-712 signatures bind payer, recipient, asset, amount, nonce, deadline, chain, and router.
- The payer approves a token allowance; a role-authorized relayer pays native gas and executes settlement.
- Payer-scoped payment IDs and nonces prevent replay on chain. Unique intent records and fingerprints make API retries idempotent.
- Token roles control issuance, account eligibility, maximum supply, and emergency pause.
- Router policy enforces allowed assets, per-payment caps, UTC-day payer limits, nonce cancellation, and pause.
- Effects and token movement revert atomically; recipient balance checks reject incompatible transfer amounts.
- Signed transaction bytes are stored before broadcast, allowing the worker to retry the same transaction hash after an uncertain outcome.
- File-backed recovery tests kill a real worker process at dispatch/finalization boundaries and verify that restart does not duplicate a transfer or journal row. Persisted broadcasts retain nonce priority even if the wall clock moves backward.
- Controlled HTTP-proxy tests verify retry after 503 responses, dropped connections, silent transport timeouts, and a lost response after upstream transaction acceptance. RPC-mode HTTP exchanges have a configurable timeout.
- A matching settlement event, configured confirmation count, and canonical block are required before the transfer journal is finalized.
- Reconciliation flags recorded settlements whose receipt or block is no longer canonical.
- Payment and journal APIs support bounded cursor pages, and exact integer transfer-volume totals are grouped by asset. Reconciliation scans all settled pages rather than a recent-record cutoff.
- A React dashboard exposes actual payment states, block data, receipts, and local audit events.
- A network generator and Docker Compose definition target four Besu QBFT validators. Live multi-node operation remains unverified.

## Repository

| Path | Responsibility |
| --- | --- |
| `contracts/` | Original DemoUSD and SettlementRouter contracts |
| `src/` | API, durable journal, EVM adapter, settlement worker |
| `web/` | React dashboard |
| `tests/` | EVM, accounting, recovery, and HTTP integration tests |
| `scripts/` | Compilation, build, demo, network setup, counting |
| `network/` | Four-validator Besu development configuration |
| `docs/` | Architecture, API, security, validation, provenance |
| `upstream/besu-26.10.1/` | Besu release source with original LICENSE and NOTICE |

## Verify

```sh
npm run typecheck
npm test
npm run build
npm run source:count
```

The latest combined Windows run passed **54 tests**, and strict TypeScript checking passed. The public source was published on October 25, 2026, and its first [GitHub Actions run passed](https://github.com/samadalam481470sa-cmd/clearledger/actions/runs/40173477932): dependency installation, typecheck, tests, Solidity/frontend build, and source counting all succeeded. See [validation](docs/VALIDATION.md) and [current status](STATUS.md) for evidence and remaining limits.

## More than 100,000 source lines

The [machine-readable count](docs/source-count.json) separates original and upstream source. The current count is **624,796 nonblank source lines**: 1,884 original and 622,912 in the included Besu release, including comments and tests. Package installs, lockfiles, JSON, documentation, generated output, and databases are excluded. The size requirement is met by attributed upstream code; it is not a claim that all those lines were independently authored for ClearLedger.

Original application code is MIT-licensed. Besu and installed dependencies retain their own licenses. [Provenance](docs/PROVENANCE.md) pins the release, commit, and download hash.

## Four-validator development mode

Requires Docker Compose:

```sh
npm run network:generate
docker compose -f network/compose.yaml up -d
npm run network:deploy
```

The generator refuses to overwrite an existing `network/generated/` directory. Validator and account keys are ignored by Git. Only validator 1's RPC endpoint is published, on loopback port 8545. Read the [network guide](docs/NETWORK.md) before using this mode. Four containers on one host are not four independent failure domains.

## External development RPC

Deploy the contracts, configure the environment variables in [API.md](docs/API.md), then run `npm start`. This mode persists to `data/clearledger.sqlite` by default and has no demo signing or bootstrap endpoints.

Run **one service instance per relayer key and database**. There is no distributed worker lease. Review [architecture](docs/ARCHITECTURE.md), [security boundaries](docs/SECURITY.md), and the [roadmap](ROADMAP.md) before extending it.

For a recruiter walkthrough, see the [portfolio guide](docs/PORTFOLIO.md).
