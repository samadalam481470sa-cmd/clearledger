# ClearLedger roadmap

Prioritize verified payment correctness and demonstrable engineering over source size.

## Verified baseline

Source `90c3b0cafce9777753f7482aeb99a989f4a36596` passed all 1,194 regular Linux tests with zero failures or skips, plus strict typecheck, build and source count. [Regular CI](https://github.com/samadalam481470sa-cmd/clearledger/actions/runs/43757530351).

Source `677fa8f5382c21fb8173377ad336100b785b8f96` passed all 11 Besu checks, including EOA and contract-wallet quorum recovery, revocation and reconciliation of three journals. [Besu CI](https://github.com/samadalam481470sa-cmd/clearledger/actions/runs/43754715963).

The CLI rollback case is included in the regular suite. The extended receipt outage test on source `a0c13705da1434864e3f899eb15bf30dee398e64` observed 645,255 ms across abrupt restart with 1,440 successful authenticated history responses in bursts of 12. [Extended outage CI](https://github.com/samadalam481470sa-cmd/clearledger/actions/runs/43698870254) · [Concurrent history evidence](STATUS.md#concurrent-history-reads-during-receipt-outage).

Reconciliation reports distinguish new flags from all outstanding reviews. Totals validate posting relationships, retained transfer fields, inclusion metadata and transaction hash uniqueness across posted journals. The dashboard supports cursor pages, exact payment lookup and separate journaled settled/review volume. Browser layout, mounted interaction and accessibility remain unverified under the existing origin denial.

The count is 640,805 nonblank source lines, comprising 17,893 application-area lines and 622,912 attributed Besu lines, including comments and tests. The application area includes the attributed signature-check adaptation. Historical measurements and earlier failures remain tied to their recorded revisions in [STATUS.md](STATUS.md) and [VALIDATION.md](docs/VALIDATION.md).

## Next increments

1. Extend the verified receipt-outage bursts toward longer outages, sustained load and soak validation with a larger journal and explicit observation boundaries.
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
