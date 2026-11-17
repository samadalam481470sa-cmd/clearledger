# ClearLedger — recruiter walkthrough

**Project:** [ClearLedger](https://github.com/samadalam481470sa-cmd/clearledger) · **Type:** fintech engineering portfolio prototype · **Stack:** Solidity, TypeScript/Node.js, SQLite, React, EVM; optional four-validator Besu QBFT development network.

## 30-second pitch

> ClearLedger demonstrates how an authorized payment becomes an on-chain transfer and a traceable settlement journal. I developed and integrated Solidity payment controls, a TypeScript API and settlement worker, SQLite records, and a React operations dashboard, with AI assistance noted in the project provenance. EIP-712 signatures and on-chain nonces guard authorization and replay, while persisted signed transactions and receipt-based reconciliation address crashes and uncertain RPC outcomes. It's a test-asset engineering prototype—not a bank, a stablecoin, or a production payment processor.

## Architecture in one minute

```text
Payer signs EIP-712 intent
    -> authenticated TypeScript API -> SQLite payment intent
    -> single-relayer settlement worker -> SettlementRouter -> DemoUSD
    -> confirmed canonical receipt + expected event -> SQLite transfer journal
    -> React dashboard / payment history / reconciliation
```

- **`contracts/`:** DemoUSD token roles and controls, plus SettlementRouter authorization, nonces, supported assets, transfer limits, cancellation, and pause.
- **`src/`:** HTTP API, durable payment states, signed-transaction reservation/recovery, chain adapter, receipt checks, and reconciliation.
- **`web/`:** payment and journal views, receipt/block details, per-asset totals, and local audit events.
- **`tests/` and `scripts/`:** contract, Store, process-restart, HTTP-fault, API and network validation.
- **`network/`:** a separate single-host, four-validator Besu QBFT **development** mode; `npm run demo` instead uses a local in-memory EVM. `upstream/besu-26.10.1/` is attributed third-party infrastructure, not original ClearLedger consensus code.

The chain determines token ownership. SQLite provides the operational payment history and paired debit/credit **transfer journal**, not a complete bank/general ledger or a second authoritative token balance.

## Strongest engineering decisions

1. **Separate authorization from gas payment.** The payer signs an EIP-712 instruction bound to chain, router, payer, recipient, token, amount, nonce, and deadline; a role-authorized relayer executes it. EOA and ERC-1271 contract-wallet validation are supported.
2. **Defend against two kinds of duplicates.** Payer-scoped payment IDs and unique intent fingerprints make API retries idempotent; router nonces and payment IDs prevent on-chain replay. This is *not* a claim of exactly-once network delivery.
3. **Make uncertainty recoverable.** The worker commits signed transaction bytes and hash before broadcast. On restart it prioritizes reserved broadcasts, checks raw/hash and signed-envelope coherence before retransmission, and preserves nonce priority rather than signing a replacement on ambiguous outcomes.
4. **Finalize against chain evidence.** Settlement requires the expected router event, coherent receipt/block identity, configured confirmation depth, and a canonical block. Reconciliation flags mismatches for review without silently deleting or reversing historical journal entries.
5. **Treat accounting and observability as correctness concerns.** SQLite transitions and audit/journal writes are transactional; transfers use exact integer base units, bounded cursor pages, and per-asset totals that refuse inconsistent journal relationships instead of displaying misleading partial amounts.

## Evidence you can show

- **[Main-branch Linux CI, commit `118da400`](https://github.com/samadalam481470sa-cmd/clearledger/actions/runs/40820825048):** documented passing **797 tests, zero skips**, plus typecheck, Solidity/frontend build, fresh install, and source count.
- **[Besu Docker acceptance, same source](https://github.com/samadalam481470sa-cmd/clearledger/actions/runs/40820824774):** scripted EOA settlement, quorum-loss observation with two stopped validators, same-transaction recovery, wallet settlement/revocation, and reconciliation on **one Ubuntu Docker host**.
- **[Validation record](VALIDATION.md):** bounded file-backed worker-crash/restart, lost-response/HTTP fault, lifecycle-integrity, and canonical-receipt checks. These are specified tests, not a production uptime or throughput benchmark.
- **[Security boundaries](SECURITY.md) and [source provenance](PROVENANCE.md):** what was tested, what was adapted, and what remains unverified. CI proves the tested scenarios passed, not that the application is audited or production-ready.

## Five-minute demo

1. Run `npm ci`, `npm run build`, `npm test`, then `npm run demo`; open `http://127.0.0.1:4317`. Explain that the demo resets on exit and does **not** start the Besu validator network.
2. Show the three seeded payments; create a **250 dUSD** Treasury-to-Merchant signed payment. Identify the payer, relayer-funded gas, payment ID, nonce, transaction hash, receipt, and block.
3. Try **10,000.000001 dUSD** and explain the router's per-payment-cap rejection. Clarify that router limits do not govern direct token transfers.
4. Open the payment and journal pages. Explain matched debit/credit records, exact per-asset totals, and why a review item is kept visible.
5. Click **Reconcile**; explain how a canonical-chain mismatch would flag review. Point to the recovery and controlled-RPC-failure tests instead of pretending a live outage happened during the demo.

## Honest boundaries and attribution

- **Demo USD has no monetary value, reserves, or redemption.** There is no live banking/payment-rail integration, security audit, production custody, KMS/HSM, compliance program, or public multi-tenant deployment.
- Reconciliation **detects** certain mismatches; complete reorg accounting repair and full-chain event indexing are not implemented. A single cooperating relayer/SQLite database is not a distributed signer lease. No independently measured production SLO, hours-long soak, or throughput claim.
- The four Besu validators run on **one host**, not independent failure domains. Browser appearance, accessibility, and end-user interactions have not been independently verified in the validation record.
- Original project application/integration/tests/docs are separate from the **attributed Besu 26.10.1** release source in `upstream/`. The repository's source count distinguishes **11,946 application** from **622,912 upstream Besu** nonblank lines; do **not** represent all ~635k lines as original work. The signature checker includes an attributed OpenZeppelin adaptation; the project [discloses AI assistance](PROVENANCE.md).

## Interview questions: short answer points

**How do you prevent double settlement?** — Unique API intent and payer-scoped IDs handle repeat requests; contract nonce/payment-ID checks block replay. The worker reuses stored signed bytes on retry, and journal transitions reject conflicting duplication.

**What happens if RPC accepts a transaction but the worker crashes?** — Signed bytes and hash were reserved in SQLite before sending. After restart the worker searches for the receipt or safely retransmits the same validated transaction; an unresolved reservation takes nonce priority.

**Why SQLite *and* blockchain?** — On-chain token state determines ownership; SQLite tracks pending work, status changes, receipts, paired transfer journal entries, and operator-facing history. SQLite is mutable and not a trustless ledger.

**How do you handle a chain reorganization?** — Require matching receipt/event and confirmation/canonical-block checks before finalization, then reconcile recorded settlements. Suspected mismatches are flagged for human review; automatic ledger repair is not claimed.

**What does the Besu demo prove?** — The **scripted** four-validator single-host QBFT environment settled real test transactions, stopped progressing with insufficient quorum, and recovered the same pending transaction after quorum returned. It does not prove independent-region fault tolerance.

**What would be needed for real money?** — Independent security review; production key/custody and identity/compliance controls; robust indexing/reorg correction, disaster recovery/soak, monitoring, distributed coordination, and integration with regulated rails.

## Résumé line

> Built and tested a fintech settlement prototype with Solidity, TypeScript, React, and SQLite, implementing typed signed-payment authorization, replay/idempotency controls, crash-aware dispatch, and canonical-chain reconciliation; integrated an attributed Besu QBFT development network.

Use this wording only after you can run and explain the project. Describe it as a **portfolio project**, not employment, audited infrastructure, or a live payment service.
