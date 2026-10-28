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
- EOA and deployed ERC-1271 wallet authorization share one router view, checked at API acceptance and again at dispatch/execution. Wallet authorization can be revoked; existing routers need redeployment with the new ABI/address. Twenty-two local-EVM contract-wallet checks and all 253 Linux CI cases pass; see [authorization behavior](docs/API.md#contract-wallet-authorization-and-retries).
- The payer approves a token allowance; a role-authorized relayer pays native gas and executes settlement.
- Payer-scoped payment IDs and nonces prevent replay on chain. Unique intent records and fingerprints make API retries idempotent.
- Token roles control issuance, account eligibility, maximum supply, and emergency pause.
- Router policy enforces allowed assets, per-payment caps, UTC-day payer limits, nonce cancellation, and pause.
- Effects and token movement revert atomically; recipient balance checks reject incompatible transfer amounts.
- Signed transaction bytes are stored before broadcast. When no receipt exists, retransmission requires nonempty byte-aligned hex bytes whose Keccak-256 matches the stored hash; inconsistent evidence retains the broadcast reservation and nonce priority.
- File-backed recovery tests kill a real worker process at dispatch/finalization boundaries and verify that restart does not duplicate a transfer or journal row. Persisted broadcasts retain nonce priority even if the wall clock moves backward.
- Atomic Store transition guards reject conflicting lifecycle/journal updates, while exact repetitions preserve the existing audit history without duplicate entries.
- Invalid queued records with no stored transaction reservation fail with a fixed diagnostic and retained evidence, allowing independent work to proceed. Any queued raw/hash reservation blocks new allocation and cannot be overwritten or discarded through Store mutations. See [queued integrity](docs/API.md#invalid-queued-authorization).
- Controlled HTTP-proxy tests verify retry after 503 responses, dropped connections, silent transport timeouts, and a lost response after upstream transaction acceptance. RPC-mode HTTP exchanges have a configurable timeout.
- RPC startup binds each database to its chain, genesis, router and relayer identity. Incompatible deployments and nonempty unbound legacy databases are refused; review [database context guidance](docs/API.md#rpc-database-context) before changing deployments.
- RPC startup also acquires exclusive ownership of its canonical local database file before opening the ledger or starting HTTP/dispatch. A second cooperating CLI refuses startup; process exit permits restart without deleting the persistent SQLite lock sidecar. Separate databases sharing a relayer key still require operator coordination; see [ownership limits](docs/API.md#rpc-database-ownership).
- A matching settlement event, configured confirmation count, and canonical block are required before the transfer journal is finalized. The event's transaction hash, block hash, and height must agree with its receipt; contradictory matching logs preserve the broadcast reservation for retry.
- Reconciliation flags recorded settlements whose receipt or block is no longer canonical.
- Payment and journal APIs support bounded cursor pages, and exact integer transfer-volume totals are grouped by asset. Reconciliation scans all settled pages rather than a recent-record cutoff.
- Invalid stored authorization data remains visible in history with a fixed warning and retained record/transaction metadata. Dashboard rows and receipts show placeholders for unavailable amounts or routes; reads do not repair financial records. See [nullable payment records](docs/API.md#invalid-stored-payment-data).
- A React dashboard browses payment and transfer-journal cursor pages, shows settled/review volume separately per asset, and exposes receipt snapshots, block data, and recent local audit events. Chain-scoped configured metadata enables exact decimal display; unknown assets or metadata failing frontend display checks keep raw base units. Startup validates address checksums; the frontend checks nonzero address syntax without EIP-55 validation. An older demo can format its known token only when the registry is absent; present empty/invalid registries disable that fallback. See [metadata behavior](docs/API.md#asset-display-metadata).
- A four-validator Besu QBFT network passed real Docker acceptance on GitHub Actions Ubuntu: signed EOA settlement, progress with one validator stopped, a healthy-RPC no-finalization window with two stopped, and same-transaction settlement after quorum restoration.

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

[Linux CI passed all 603 tests with zero skips](https://github.com/samadalam481470sa-cmd/clearledger/actions/runs/40650583555), strict typecheck, the Solidity/Vite build, and source counting. [Four-validator Besu settlement, quorum-loss recovery and contract-wallet checks also passed](https://github.com/samadalam481470sa-cmd/clearledger/actions/runs/40650583629). Recovery hash-binding checks use adversarial SQLite and real HTTP/Ganache: the worker sent no mismatched bytes, original-byte restoration settled two payments once, and a genuine existing receipt confirmed without retransmission. These corruption cases use manual service ticks; separate tests cover actual CLI recovery. Local Windows verification completed 603 cases (598 passes, five existing platform skips, zero failures). Browser appearance/interaction remains unverified. See [validation](docs/VALIDATION.md) and [current status](STATUS.md) for evidence and limits.

A bounded receipt-outage test passed a measured 60,705 ms/59 observations in CI across actual worker termination/restart and file-backed SQLite reopen, with both payments settling once after recovery. Retries were driven by serialized IPC commands; this is not an autonomous daemon, Besu-network run, or hours-long soak.

A new bounded actual-CLI test covers a signed reservation whose repeated send attempts are blocked before upstream acceptance. It checks absent upstream transaction/receipt and unchanged balances/nonces across process termination/restart, then recovery of the identical transaction and queued nonce priority. The local targeted case and typecheck pass; Linux CI also passed this case with four blocked attempts on each side of restart, zero upstream forwards during the fault, and two recovered settlements. See [unpropagated recovery](docs/VALIDATION.md#unpropagated-rpc-cli-reservation-recovery).

Shutdown coordinates worker and HTTP drains before closing shared resources on SIGINT/SIGTERM. Linux CI passed all 603 tests, including actual RPC CLI autonomous crash recovery and SIGTERM drain/restart with real HTTP, EVM and SQLite. Windows explicitly skips the two POSIX signal paths. These bounded scenarios do not establish a daemon soak or production availability. See the [shutdown operation](docs/API.md#shutdown) for the cooperative deadline and forced-termination limits.

Reconciliation cross-checks recorded payment/journal provenance with the receipt, canonical block, and configured router's settlement event. That increment's local verification completed 181 cases: 180 passes, zero failures, and one explicit POSIX skip on Windows. Linux CI passed all 181 tests, and the four-validator Besu settlement/quorum-loss/recovery workflow also passed. See [validation](docs/VALIDATION.md#reconciliation-integrity) for evidence and limits. Mismatches flag review while retaining journal history, without automatic accounting reversal.

Initial confirmation leaves inconsistent or malformed RPC receipt data in broadcast for retry. Both success and revert require matching transaction/canonical-block identity and configured confirmation depth before a terminal outcome; success also requires the expected router event. The 47 synthetic checks and two real-EVM recovery regressions pass, along with typecheck and build; the full local suite completed 230 cases (229 passes, zero failures, one explicit Windows POSIX skip) in 176,888.358 ms. Linux CI passed all 230 tests, and the same source passed the four-validator Besu settlement/recovery scenario.

The [dependency maintenance record](docs/DEPENDENCIES.md) documents patched validation/build dependencies and 33 remaining Ganache-tree audit entries, including critical findings. Successful correctness checks do not establish dependency security.

A Besu acceptance extension now includes a caller-bound test contract wallet: settle 12.5 dUSD after EOA quorum recovery, then revoke a queued 1.25 dUSD authorization before signing and require no new journal/native reservation. The extended live Besu workflow passed: three journals, wallet balance 87.5 dUSD, recipient total 175 dUSD, and four-node state agreement at block 45. All 253 regular CI tests also passed. This tooling increment leaves the router/API unchanged and does not test wallet transactions during quorum loss.

## More than 100,000 source lines

The [machine-readable count](docs/source-count.json) separates original and upstream source. The current count is **632,092 nonblank source lines**: 9,180 application and 622,912 in the included Besu release, including comments and tests. Package installs, lockfiles, JSON, documentation, generated output, and databases are excluded. The size requirement is met by attributed upstream code; it is not a claim that all those lines were independently authored for ClearLedger.

Application code is MIT-licensed, including a clearly attributed OpenZeppelin-derived signature-check adaptation. Its lines are included in the application source count; the Besu count remains separate. Besu and installed dependencies retain their own licenses. [Provenance](docs/PROVENANCE.md) records these distinctions and pins the Besu release, commit, and download hash.

## Four-validator development mode

Requires Docker Compose:

On Linux, set the container UID/GID to the generating user's identity before these commands, as shown in the [network guide](docs/NETWORK.md), so private key permissions remain restricted.

```sh
npm run network:generate
docker compose -f network/compose.yaml up -d
npm run network:verify
```

`network:verify` deploys test contracts, settles/reconciles 125 dUSD, and checks continued progress after stopping validator 4. That original one-stop/restart scenario passed on GitHub Actions Ubuntu, not the original Windows host. For separate reusable test-account deployment, run `npm run network:deploy` after the chain is healthy.

The script also stops validator 3, drains in-flight imports until two healthy agreeing heads are stable for eight seconds, and observes 20 seconds without finalization while a 37.5 dUSD payment remains pending. It allows up to 300 seconds for quorum restoration and requires settlement of the same signed transaction once before all-four catch-up. This full extension passed with two journals, payer nonce 2, recipient balance 162.5 dUSD, and zero reconciliation exceptions. The diagnostic recovery bound is not an SLO or guarantee.

The generator refuses to overwrite existing `network/generated/` keys. Four validator containers stay on an internal network; a fifth, non-root RPC gateway publishes only host-loopback ports 8545–8548 and has no key mounts. Read the [network guide](docs/NETWORK.md) before using this mode. The four validators still share one host and are not independent failure domains.

## External development RPC

Deploy the contracts, configure the environment variables in [API.md](docs/API.md), then run `npm start`. This mode persists to `data/clearledger.sqlite` by default and has no demo signing or bootstrap endpoints.

Run **one service instance per relayer key and database**. There is no distributed worker lease. Review [architecture](docs/ARCHITECTURE.md), [security boundaries](docs/SECURITY.md), and the [roadmap](ROADMAP.md) before extending it.

For a recruiter walkthrough, see the [portfolio guide](docs/PORTFOLIO.md).
