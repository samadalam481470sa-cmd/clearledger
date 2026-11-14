# ClearLedger

**Signed payments, on-chain settlement, and a reconciled transfer journal.**

[Public repository](https://github.com/samadalam481470sa-cmd/clearledger) · [![ClearLedger checks](https://github.com/samadalam481470sa-cmd/clearledger/actions/workflows/ci.yml/badge.svg)](https://github.com/samadalam481470sa-cmd/clearledger/actions/workflows/ci.yml) · [![Besu network checks](https://github.com/samadalam481470sa-cmd/clearledger/actions/workflows/network.yml/badge.svg)](https://github.com/samadalam481470sa-cmd/clearledger/actions/workflows/network.yml)

ClearLedger is a fintech engineering portfolio prototype built on EVM infrastructure. Its original application combines Solidity payment controls, a TypeScript settlement worker, SQLite accounting records, and a React operations dashboard. An attributed **Besu 26.10.1 source snapshot** is included under `upstream/`.

Demo USD has no monetary value, reserves, or redemption promise. This project is unaudited and has no banking integration. The consensus implementation is Besu's work; ClearLedger's original contribution is the payment application and its integration, tests, and documentation.

## Run the local demo

Requires Node.js 24+ and npm. Docker and a wallet extension are unnecessary for this mode. CI checks the exact reference versions in `.node-version` and `.npm-version`; see [toolchain pins and limits](docs/DEPENDENCIES.md#reference-ci-toolchain).

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
- EOA and deployed ERC-1271 wallet authorization share one router view, checked at API acceptance and again at dispatch/execution. Wallet authorization can be revoked. Router upgrades require the matching ABI and deployed address. [Authorization behavior](docs/API.md#contract-wallet-authorization-and-retries).
- The payer approves a token allowance; a role-authorized relayer pays native gas and executes settlement.
- Payer-scoped payment IDs and nonces prevent replay on chain. Unique intent records and fingerprints make API retries idempotent.
- Token roles control issuance, account eligibility, maximum supply, and emergency pause.
- Router policy enforces allowed assets, per-payment caps, UTC-day payer limits, nonce cancellation, and pause.
- Effects and token movement revert atomically; recipient balance checks reject incompatible transfer amounts.
- Signed transaction bytes are stored before broadcast. Both retransmission and receipt processing require byte/hash coherence and a signed type 0/1/2 envelope matching the configured chain, relayer, router, zero native value and exact saved settlement calldata. Inconsistent evidence retains the reservation and nonce priority. [Recovery envelope limits](docs/API.md#recovered-transaction-envelope).
- File-backed recovery tests kill a real worker process at dispatch/finalization boundaries and verify that restart does not duplicate a transfer or journal row. Persisted broadcasts retain nonce priority even if the wall clock moves backward.
- Atomic Store transition guards reject conflicting lifecycle/journal updates, while exact repetitions preserve the existing audit history without duplicate entries.
- Native failures with top-level `ERR_SQLITE_ERROR` return a fixed HTTP 500 diagnostic without SQL/trigger details. Acceptance may already be committed when a later storage step fails; inspect history before retrying the original instruction. See [storage-error behavior](docs/API.md#sqlite-http-errors).
- Invalid queued records with no stored transaction reservation fail with a fixed diagnostic and retained evidence, allowing independent work to proceed. Any queued raw/hash reservation blocks new allocation and cannot be overwritten or discarded through Store mutations. See [queued integrity](docs/API.md#invalid-queued-authorization).
- Controlled HTTP-proxy tests verify retry after 503 responses, dropped connections, silent transport timeouts, and a lost response after upstream transaction acceptance. RPC-mode HTTP exchanges have a configurable timeout. Upstream errors classified as `BAD_DATA` receive a fixed redacted HTTP 503 response. [RPC error behavior](docs/API.md#rpc-error-responses).
- RPC startup binds each database to its chain, genesis, router and relayer identity. Incompatible deployments and nonempty unbound legacy databases are refused; review [database context guidance](docs/API.md#rpc-database-context) before changing deployments.
- The durable RPC CLI awaits a bound loopback listener before worker dispatch. A refused port preserves existing payment, audit and journal records; cleanup closes Store before releasing ownership. Earlier schema/context initialization can still write. See [listener readiness](docs/API.md#rpc-listener-readiness).
- RPC startup also acquires exclusive ownership of its canonical local database file before opening the ledger or starting HTTP/dispatch. A second cooperating CLI refuses startup; process exit permits restart without deleting the persistent SQLite lock sidecar. Separate databases sharing a relayer key still require operator coordination; see [ownership limits](docs/API.md#rpc-database-ownership).
- A matching settlement event, configured confirmation count, and unique transaction membership at the receipt index are required before the transfer journal is finalized. The event's transaction hash, block hash, and height must agree with its receipt; contradictory matching logs preserve the broadcast reservation for retry.
- Reconciliation checks saved authorization, signed bytes, receipt identity, transaction position, settlement event and journal. It distinguishes newly flagged records from all outstanding reviews, including unjournaled payments. Inconclusive missing-RPC evidence can return a retryable HTTP 503. [Reconciliation scope](docs/API.md#reconciliation-integrity).
- Payment and journal APIs support bounded cursor pages, and exact integer transfer-volume totals are grouped by asset. Required missing postings, orphan/out-of-status journals, or malformed included journal tokens/amounts make the whole totals report unavailable; the dashboard clears cached totals/counts rather than showing partial or zero values. See [totals integrity](docs/API.md#journal-totals-integrity). Reconciliation scans all settled pages rather than a recent-record cutoff.
- Invalid stored authorization data remains visible in history with a fixed warning and retained record/transaction metadata. Dashboard rows and receipts show placeholders for unavailable amounts or routes; reads do not repair financial records. See [nullable payment records](docs/API.md#invalid-stored-payment-data).
- A React dashboard browses payment and transfer-journal cursor pages, shows settled/review volume separately per asset, and exposes receipt snapshots, block data, and recent local audit events. Chain-scoped configured metadata enables exact decimal display; unknown assets or metadata failing frontend display checks keep raw base units. Startup validates address checksums; the frontend checks nonzero address syntax without EIP-55 validation. An older demo can format its known token only when the registry is absent; present empty/invalid registries disable that fallback. See [metadata behavior](docs/API.md#asset-display-metadata).
- After a successful initial overview, per-asset totals refresh independently of later overview RPC failures or stalls, using the last successful chain/router context and metadata. See [refresh verification](docs/VALIDATION.md#independent-dashboard-refresh).
- The four-validator Besu QBFT acceptance checks cover EOA and contract-wallet settlements, progress with one validator stopped, pending transactions with two stopped, recovery of the original reservations, queued wallet revocation and final node agreement.

## Repository

| Path | Responsibility |
| --- | --- |
| `contracts/` | DemoUSD and SettlementRouter, with an attributed signature-check adaptation |
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

The results below belong to the stated source revisions. Documentation-only commits can follow those revisions.

| Verification | Reviewed source | Completed evidence |
| --- | --- | --- |
| Regular Linux suite | `708f90d6` | 1,110 tests passed with zero failures or skips. Fresh install, strict typecheck, Solidity compilation, dashboard build and source count passed. [CI run](https://github.com/samadalam481470sa-cmd/clearledger/actions/runs/43561276671) |
| Four-validator Besu | `98f51556` | All 11 checks passed on one Docker host in 372,385 ms, including EOA and contract-wallet quorum recovery, revocation and reconciliation of three journals. [CI run](https://github.com/samadalam481470sa-cmd/clearledger/actions/runs/42357920444) |
| CLI crash and rollback recovery | `86460563` | The CLI recovered the original signed reservation after a controlled Ganache rollback, then settled two payments on the final chain with two journals and reconciliation 2/0. [Evidence](STATUS.md#cli-recovery-after-a-rolled-back-settlement) |
| Longer receipt outage | `bd7137fd` | Two five-minute observation windows recorded 634,266 ms of active checks and 360 authenticated HTTP 200 history responses across abrupt restart. Two payments recovered with two journals and reconciliation 2/0. [Dedicated CI run](https://github.com/samadalam481470sa-cmd/clearledger/actions/runs/42336374899) |

The dedicated outage workflow runs when its own definition or the outage test changes. Other source revisions can use manual dispatch. Its fault affects the receipt route, and the parent retains direct chain access. Active observation excludes startup and restart downtime. [Outage procedure and limits](docs/API.md#recovery).

The network checks use one host and a test contract wallet. Browser layout, mounted interactions and accessibility remain unverified because browser-origin access was denied. Longer load tests, arbitrary partitions, independent-host failures and production operation remain future work.

Detailed regression results and earlier failures retain their original source revisions in [STATUS.md](STATUS.md) and the [validation record](docs/VALIDATION.md). Dependency maintenance and remaining audit findings are tracked in the [dependency record](docs/DEPENDENCIES.md).

## More than 100,000 source lines

The [machine-readable count](docs/source-count.json) records **639,999 nonblank source lines**, including comments and tests.

| Source area | Files | Nonblank lines |
| --- | --- | --- |
| ClearLedger application area | 115 | 17,087 |
| Attributed Besu snapshot | 4,484 | 622,912 |
| Combined | 4,599 | 639,915 |

Package installs, lockfiles, JSON, documentation, generated output and databases are excluded. Application-area counting includes the clearly attributed OpenZeppelin-derived signature-check adaptation. Application code is MIT-licensed. Besu and dependencies retain their own licenses, and the consensus implementation belongs to Besu. [Provenance and licenses](docs/PROVENANCE.md).

## Four-validator development mode

Requires Docker Compose:

On Linux, set the container UID/GID to the generating user's identity before these commands, as shown in the [network guide](docs/NETWORK.md), so private key permissions remain restricted.

```sh
npm run network:generate
docker compose -f network/compose.yaml up -d
npm run network:verify
```

`network:verify` deploys test contracts, settles 125 dUSD and checks progress after stopping validator 4. With validators 3 and 4 stopped, a second EOA payment for 37.5 dUSD must remain pending during a 20-second observation. It settles the original reservation after quorum returns.

A later 12.5 dUSD contract-wallet payment undergoes a second two-validator stop and recovery. The script then checks queued wallet revocation, three journals, recipient balance 175 dUSD and wallet balance 87.5 dUSD, followed by four-node state agreement. Both restoration polls share a 600-second script deadline. [Network procedure and measured limits](docs/NETWORK.md).

For reusable development-account deployment, run `npm run network:deploy` after the chain is healthy. Docker acceptance was verified on GitHub Actions Ubuntu.

The generator refuses to overwrite existing `network/generated/` keys. Four validator containers stay on an internal network; a fifth, non-root RPC gateway publishes only host-loopback ports 8545–8548 and has no key mounts. Read the [network guide](docs/NETWORK.md) before using this mode. The four validators still share one host and are not independent failure domains.

## External development RPC

Deploy the contracts, configure the environment variables in [API.md](docs/API.md), then run `npm start`. This mode persists to `data/clearledger.sqlite` by default and has no demo signing or bootstrap endpoints.

Run **one service instance per relayer key and database**. There is no distributed worker lease. Review [architecture](docs/ARCHITECTURE.md), [security boundaries](docs/SECURITY.md), and the [roadmap](ROADMAP.md) before extending it.

For a recruiter walkthrough, see the [portfolio guide](docs/PORTFOLIO.md).
