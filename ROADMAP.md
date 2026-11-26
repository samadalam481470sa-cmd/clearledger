# ClearLedger roadmap

Prioritize verified payment correctness and demonstrable engineering over source size.

## Verified baseline

Source `08e36039aafbbafdb530c4fe436327bd2ca36b0a` passed all 1,560 regular Linux tests with zero failures or skips, plus vendored Besu verification, strict typecheck, build and source-report verification. The network driver adds a second unresolved CLI crash before quorum returns, with three distinct actual CLI lifetimes sharing one deployment-bound ledger and two full 20-second no-quorum observations. The Docker scenario is exercised by the separate Besu job. Existing preparation, confirmation and reconciliation snapshot guards remain covered by the regular suite. [Regular CI](https://github.com/samadalam481470sa-cmd/clearledger/actions/runs/45723706385) · [Repeated-crash evidence and limits](STATUS.md#repeated-cli-crashes-during-besu-quorum-loss).

The same source passed all 13 Besu checks in 394,337 ms. CLI PIDs 5358/5378/5556 retained the original reservation across two unresolved SIGKILL faults and separate 20,060.098809/20,056.913341 ms halted windows, with 20 observations each. CLI3 autonomously recovered that original transaction with one total additional native nonce and authenticated reconciliation 2/0; its final stop was cleanup. Wallet quorum recovery, revocation and final reconciliation 3/0 also passed. Parent providers stay alive, wallet phases are manually driven and validators share one host. Inclusion-boundary crashes and arbitrary failure timing remain unverified. [Besu CI](https://github.com/samadalam481470sa-cmd/clearledger/actions/runs/45723706364).

The CLI rollback case is included in the regular suite. On source `14e5a43caac52ce8548bbaf5e2cb2f7ceb6088ac`, extended receipt-outage CI retained 101 historical settlements and four frozen journal continuation pages across abrupt CLI restart. Two five-minute windows measured 644,596 ms active and 1,920 authenticated HTTP 200 responses in bursts of 16. All three capped overview/oldest-lookup controls passed. Healing produced 103 journals, fresh pages 25/25/25/25/3 and reconciliation 103/0. Setup and rate-bucket cooldown are excluded from active observations. [Extended outage CI](https://github.com/samadalam481470sa-cmd/clearledger/actions/runs/45411379967) · [Evidence and limits](STATUS.md#multi-page-journal-history-during-receipt-outage). Earlier 26-record measurements remain tied to their original source in STATUS.

Reconciliation reports distinguish new flags from all outstanding reviews. Known local journal contradictions are reviewed before RPC, with the original evidence retained. Totals validate posting relationships, retained transfer fields, inclusion metadata and transaction hash uniqueness across posted journals. The dashboard supports cursor pages with bounded client waits, exact payment lookup and separate journaled settled/review volume. Independent overview and totals refreshes now have client deadlines and retain last-good data through stalled responses. Browser layout, mounted interaction and accessibility remain unverified under the existing origin denial.

A conservative cumulative-gas check now retains unresolved reservations or flags journaled settlements when reported receipt gas contradicts the snapshot’s one- and two-dimension accounting bound. It preserves original evidence and does not infer the active fork or independently authenticate the chain. [Verification and limits](STATUS.md#conservative-cumulative-gas-ceiling).

Fresh payment and journal cursors reject unsupported insertion maxima with fixed HTTP 400 errors while previously issued cursors retain their captured range. This preserves the ledger and does not add arbitrary 64-bit or mixed-nonpositive insertion support. [Boundary verification](STATUS.md#exact-pagination-range-boundaries).

The count is 646,792 nonblank source lines, comprising 23,880 application-area lines and 622,912 attributed Besu lines, including comments and tests. The application area includes the attributed signature-check adaptation. Historical measurements and earlier failures remain tied to their recorded revisions in [STATUS.md](STATUS.md) and [VALIDATION.md](docs/VALIDATION.md).

## Next increments

1. Extend the verified 101-payment history and two-window receipt-outage case toward larger datasets, longer outages, sustained load and soak validation with explicit observation boundaries.
2. Extend the bounded EOA and contract-wallet quorum scenarios to other failure timings, malicious peers, arbitrary partitions and independent-host failures.
3. Consider reviewed token-metadata governance beyond the configured display registry. Unconfigured assets retain exact base units.
4. Add a durable event indexer with checkpoints, canonical-block validation and controlled replay.
5. Design journal reversal/rebuild for reorganization recovery while preserving the audit trail and original evidence.
6. Verify dashboard interaction and accessibility after browser access becomes available.

## Further application work

- Replace the legacy development EVM with a maintained runner and review remaining dependency findings. [Dependency record](docs/DEPENDENCIES.md).
- Verify wallet-specific integrations and policy rotation beyond the generic ERC-1271 checker, including multisignature, ERC-6492 and ERC-4337 behavior.
- Add durable jobs and a distributed relayer lease before supporting multiple workers or databases sharing a signer.
- Add controlled fee replacement and stuck-nonce resolution with an audit trail.
- Introduce signer interfaces for KMS/HSM integration.
- Design explicit migration procedures for legacy unbound ledgers and intentional relayer changes.
- Demonstrate delayed role changes and multisignature governance.
- Model issuance/redemption accounting and reserve attestations as explicit simulations.
- Add telemetry, broader failure injection and measured load results.
- Extend local payment/journal checks to independently evidenced chain completeness, coherent omissions and controlled repair.

## Publication and maintenance

- Publish reviewed increments only to the existing public [ClearLedger repository](https://github.com/samadalam481470sa-cmd/clearledger), repository ID `1432932875`.
- Preserve concurrent changes and use the expected branch head when publishing.
- Exclude keys, tokens, databases, dependency installs, generated output and scratch data.
- Record completed CI outcomes against their exact source revisions.
- Keep the verified Besu container digest and workflow/toolchain references pinned, and review upgrades against the relevant verification workflows.
- Keep source counts reproducible and application/upstream attribution separate.
- Use unfunded development networks and ephemeral test accounts within the task’s file and credential boundaries.

No paid infrastructure, real financial accounts, customer data, production keys, or funded-mainnet deployment is authorized.

Shutdown ordering, crash/restart, rollback recovery and bounded quorum results establish their documented scenarios. Force-kill graceful handling, arbitrary hardware or filesystem failure, production operation and independent failure domains remain open boundaries. [Architecture](docs/ARCHITECTURE.md) · [Security](docs/SECURITY.md).
