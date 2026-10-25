# ClearLedger

**Signed payments, on-chain settlement, and a reconciled transfer journal.**

[Public repository](https://github.com/samadalam481470sa-cmd/clearledger) · [![ClearLedger checks](https://github.com/samadalam481470sa-cmd/clearledger/actions/workflows/ci.yml/badge.svg)](https://github.com/samadalam481470sa-cmd/clearledger/actions/workflows/ci.yml) · [![Besu network checks](https://github.com/samadalam481470sa-cmd/clearledger/actions/workflows/network.yml/badge.svg)](https://github.com/samadalam481470sa-cmd/clearledger/actions/workflows/network.yml)

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
- Atomic Store transition guards reject conflicting lifecycle/journal updates, while exact repetitions preserve the existing audit history without duplicate entries.
- Controlled HTTP-proxy tests verify retry after 503 responses, dropped connections, silent transport timeouts, and a lost response after upstream transaction acceptance. RPC-mode HTTP exchanges have a configurable timeout.
- A matching settlement event, configured confirmation count, and canonical block are required before the transfer journal is finalized.
- Reconciliation flags recorded settlements whose receipt or block is no longer canonical.
- Payment and journal APIs support bounded cursor pages, and exact integer transfer-volume totals are grouped by asset. Reconciliation scans all settled pages rather than a recent-record cutoff.
- A React dashboard browses payment and transfer-journal cursor pages, shows settled/review volume separately per asset, and exposes receipt snapshots, block data, and recent local audit events. Unknown/RPC assets keep their exact base units.
- A four-validator Besu QBFT network passed real Docker acceptance on GitHub Actions Ubuntu: common-chain agreement, signed settlement and reconciliation, progress with one validator stopped, and restart/catch-up.

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

The latest local suite passed **109 tests**, zero failures, and strict typecheck. The new two-validator quorum-loss scenario still awaits publication and real Docker CI; deterministic helper tests are not consensus proof. The prior [96-test GitHub Actions run](https://github.com/samadalam481470sa-cmd/clearledger/actions/runs/40213554281) passed typecheck, build, and source counting, and earlier [Besu acceptance](https://github.com/samadalam481470sa-cmd/clearledger/actions/runs/40190456959) passed one-validator failure/recovery. No local frontend build rerun is claimed for this network-only increment. Browser appearance/interaction remains unverified. See [validation](docs/VALIDATION.md) and [current status](STATUS.md) for evidence and limits.

## More than 100,000 source lines

The [machine-readable count](docs/source-count.json) separates original and upstream source. The current count is **626,199 nonblank source lines**: 3,287 original and 622,912 in the included Besu release, including comments and tests. Package installs, lockfiles, JSON, documentation, generated output, and databases are excluded. The size requirement is met by attributed upstream code; it is not a claim that all those lines were independently authored for ClearLedger.

Original application code is MIT-licensed. Besu and installed dependencies retain their own licenses. [Provenance](docs/PROVENANCE.md) pins the release, commit, and download hash.

## Four-validator development mode

Requires Docker Compose:

On Linux, set the container UID/GID to the generating user's identity before these commands, as shown in the [network guide](docs/NETWORK.md), so private key permissions remain restricted.

```sh
npm run network:generate
docker compose -f network/compose.yaml up -d
npm run network:verify
```

`network:verify` deploys test contracts, settles/reconciles 125 dUSD, and checks continued progress after stopping validator 4. That original one-stop/restart scenario passed on GitHub Actions Ubuntu, not the original Windows host. For separate reusable test-account deployment, run `npm run network:deploy` after the chain is healthy.

The script now also stops validator 3, drains in-flight imports until two healthy agreeing heads are stable for eight seconds, and observes 20 seconds without finalization while a 37.5 dUSD payment remains pending. It then restores validator 3, requires that same signed transaction to settle once, and restores validator 4 for catch-up. The full 109-test local suite and typecheck pass, but this extension's real Docker result is pending; existing live evidence covers one stopped validator only.

The generator refuses to overwrite existing `network/generated/` keys. Four validator containers stay on an internal network; a fifth, non-root RPC gateway publishes only host-loopback ports 8545–8548 and has no key mounts. Read the [network guide](docs/NETWORK.md) before using this mode. The four validators still share one host and are not independent failure domains.

## External development RPC

Deploy the contracts, configure the environment variables in [API.md](docs/API.md), then run `npm start`. This mode persists to `data/clearledger.sqlite` by default and has no demo signing or bootstrap endpoints.

Run **one service instance per relayer key and database**. There is no distributed worker lease. Review [architecture](docs/ARCHITECTURE.md), [security boundaries](docs/SECURITY.md), and the [roadmap](ROADMAP.md) before extending it.

For a recruiter walkthrough, see the [portfolio guide](docs/PORTFOLIO.md).
