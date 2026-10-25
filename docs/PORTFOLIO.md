# Portfolio walkthrough

## Five-minute demonstration

1. Start `npm run demo` and explain that its chain is a local EVM; four-node Besu is a separate launch mode.
2. Show the seeded payments and transaction receipts.
3. Submit 250 dUSD from Treasury to Merchant. Explain the payer signature and relayer-funded gas.
4. Open the receipt and identify payment ID, payer nonce, native transaction, and block.
5. Submit 10,000.000001 dUSD and show contract rejection above the per-payment cap.
6. Reconcile receipts and explain what a canonical-block mismatch would mean.
7. Open the tests and discuss crash recovery, response loss, and token conservation.
8. Browse payment and journal pages, then explain why asset volumes stay separate and RPC tokens display base units until metadata is explicitly known.

## Résumé wording

Use after running, studying, and being able to explain the implementation:

> Built and tested a fintech settlement prototype with Solidity, TypeScript, React, and SQLite, implementing EIP-712 authorizations, replay protection, configurable transfer limits, crash-aware dispatch, and canonical receipt reconciliation on a development EVM.

A separate line may describe integrating an attributed Besu release and supplying four-validator QBFT development tooling. Do not claim independently authoring Besu, inventing its consensus, passing an audit, or achieving unmeasured production throughput. Disclose AI assistance when relevant to the application or interview.

## Questions to explain

- Why signatures bind chain, contract, amount, recipient, nonce, and expiry.
- How idempotent business intent differs from exactly-once network delivery.
- Recovery before broadcast and after broadcast but before receipt recording.
- Why financial quantities use integers, not floating-point values.
- Why the chain is authoritative for ownership and SQLite is a projection.
- Why one relayer simplifies nonce allocation but limits horizontal scaling.
- Why router limits do not restrict direct token transfers.
- Why the local audit log is mutable and an on-chain receipt has different trust properties.
- Which missing features prevent real-money use.

This project demonstrates software skills; it is not employment experience, a completed security audit, or a deployed financial institution.
