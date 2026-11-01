# ClearLedger — Project details

> **Engineering prototype, not a payment processor.** All current flows use test assets. DemoUSD has no financial value, claim to reserves, or redemption promise. There is no production banking or custody integration, and the system has not received an independent security audit.

## What it is

ClearLedger is an EVM-based payment and transfer-journal application with signed EIP-712 authorizations, Solidity policy contracts, a TypeScript settlement worker, persisted transaction reservations, and a SQLite-based operational journal. A React dashboard explains payment states, receipt provenance, reconciliation, transfer volumes, network details, and audit events.

**Application page:** [Project Details](http://127.0.0.1:4317/details) (requires the local service to be started, but no API token to read the information).  
**Source:** [ClearLedger repository](https://github.com/samadalam481470sa-cmd/clearledger).

The blockchain executes token transfers and is authoritative for on-chain ownership. The local journal records the operational projection and is **not** itself an independent blockchain, a complete general ledger, or an immutable audit system.

## Technologies

| Layer | Technology | Responsibility |
| --- | --- | --- |
| Web dashboard | TypeScript 5.9, React 19.2, Vite 7.3, CSS | Payments, journals, audit history, network display, project details |
| HTTP service | Node.js 24, TypeScript, Zod 4 | Authentication, request validation, bounded cursor collections, API |
| EVM contracts | Solidity 0.8.30, OpenZeppelin | DemoUSD token, policy-controlled settlement router |
| Blockchain client | ethers 6.17 | Signed messages, chain access, receipt/event verification |
| Operational store | SQLite (`node:sqlite`) | Payment intent, transaction reservations, audit events, transfer journal |
| Local EVM | Ganache | Disposable local payment run |
| Development network | Hyperledger Besu 26.10.1, QBFT, Docker Compose | Four-validator consensus and fault simulation |
| Verification | Node test runner, GitHub Actions, Solidity and integration tests | Code validation, settlement/recovery and network checks |

The upstream Besu source included under `upstream/besu-26.10.1/` remains attributed to the original authors; ClearLedger's original application lives in `contracts/`, `src/`, `web/`, `tests/`, `network/`, `scripts/` and `docs/`.

## Core flow

1. A payer authorizes a transfer in a **typed EIP-712 message** (payer, payee, token, amount, nonce, expiry, chain and router).
2. The service validates the instruction and records a unique payment intent, using both a payment key and fingerprint to prevent conflicting API replays.
3. The worker checks policy and wallet authorization and **stores signed transaction bytes before broadcast**.
4. The Solidity router executes the approved settlement atomically, applying caps, token policy and nonce protection.
5. The worker inspects the receipt, matching event, confirmations and canonical block before recording settlement.
6. The journal stores a paired transfer entry with transaction and block provenance. Reconciliation detects mismatches and marks records for review.

## Current implementation state

**Implemented and exercised:**
- EIP-712 payment authorization, ERC-1271 compatible wallet policy, nonce and replay protection.
- Token roles, issuance limitations, allowlists, pauses and settlement caps.
- Persist-before-send transaction reservation and recovery for lost responses and process restarts.
- Durable payment/journal pages, totals separated by asset, audit history, receipt views.
- Verification of matching logs, receipt and canonical block; reconciliation to identify deviations.
- Local EVM execution and separate four-validator Besu development-network acceptance tests.
- Node / TypeScript frontend application with public read-only Project Details page.

**Not complete for real-money production:**
- Durable event indexing and checkpoint replay across restarts.
- Reorg-safe rebuilding/reversing journal projections while preserving audit evidence.
- Cross-host signer/relayer nonce coordination and resilient production-grade operations.
- Longer hostile-partition and extended soak/fault-injection testing on independent hosts.
- Independent security audit, real-world asset compliance and custody/key management.
- Full browser interaction and accessibility verification, production observability and launch readiness.

The existing source has passed documented CI test suites, but the introduction of this page alone does not constitute renewed full-system validation. See [validation evidence](VALIDATION.md) and [status](../STATUS.md) for precise runs and limitations.

## Run locally

Requires Node.js 24+ and npm:

```bash
npm ci
npm run typecheck
npm run build
npm test
npm run demo
```

Open [http://127.0.0.1:4317/details](http://127.0.0.1:4317/details) for the details page or [http://127.0.0.1:4317](http://127.0.0.1:4317) for the dashboard.

The local startup generates disposable wallets and an in-memory EVM. RPC mode instead requires separately configured authenticated access, persisted database, deployed contracts and network parameters: see [NETWORK.md](NETWORK.md), [API.md](API.md), and [SECURITY.md](SECURITY.md). Never expose the local API token or signer keys in a public site.

## Release checklist

- [x] Document the complete system and current limitations
- [x] Add public, responsive application Project Details page
- [ ] Validate new page via CI, browser navigation and accessibility checks
- [ ] Design/verify reorg-safe event indexer and journal recovery
- [ ] Extend network and infrastructure fault testing
- [ ] Complete security review, custody/compliance controls and production infrastructure

Production readiness is deliberately **not claimed** until all required controls are implemented and independently verified.
