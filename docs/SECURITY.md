# Threat model

This is unaudited portfolio software for test assets.

| Threat | Implemented control | Boundary |
| --- | --- | --- |
| Forged or altered payment | EIP-712 and OpenZeppelin ECDSA | EOA signatures only; no ERC-1271 yet |
| Replay on another chain/router | Domain separation | Cloned environments still need key hygiene |
| Duplicate request or lost response | Unique intent and persisted signed bytes; file-backed process-recovery checks | Single worker, no multi-region guarantee |
| Replay under another payment ID | Payer nonce | Clients must coordinate concurrent signing |
| Unauthorized mint/policy update | AccessControl roles | Administrator compromise remains powerful |
| Blocked recipient | Token account eligibility | No actual identity or sanctions service |
| Excess transfer | Router per-payment/daily limits | Direct token transfers bypass router limits |
| Reentrancy | ReentrancyGuard and atomic effects | Arbitrary malicious assets unsupported |
| Chain rollback | Confirmation policy and reconciliation | Detection, not automatic accounting repair |
| Hostile browser origin | Loopback bind, Host/Origin checks, CSP | Not a public multi-user API |
| API-token theft | Payer signature still required | Resource abuse/replay of valid requests remains possible |
| Interrupted local writes | SQLite WAL, synchronous FULL, atomic state/audit transactions | No backup automation or arbitrary disk-failure guarantee |
| Clock rollback during dispatch | Broadcast priority and SQLite insertion order | Single relayer owner still required |
| Ambiguous RPC preflight failure | Missing/empty revert data remains retryable | Real empty-data reverts can stall queued work |
| Short HTTP outage or lost broadcast response | Bounded HTTP exchanges, one transport attempt, durable logical retries; controlled proxy tests | Timeout is per HTTP exchange, not an overall RPC/worker deadline; no prolonged-soak claim |
| Unbounded collection response | Payment/journal page sizes 1..100 and bounded overview previews | Reconciliation can still run for a long time; it has no job-level deadline |
| Misstated settled volume after review | Exact journal-derived per-asset settled/review totals | Volume is not balance/reserves; status membership can change while paging |
| Local database mutation | On-chain transaction provenance | SQLite audit log itself is mutable |
| Local host compromise | Temporary demo keys; generated files ignored | No HSM/KMS integration |

The local demo exposes an ephemeral same-origin dashboard token and signs with a temporary server-held payer wallet. It must remain on loopback. RPC mode omits those endpoints. Neither mode is designed for direct public exposure.

RPC mode defaults to a 5,000 ms timeout per HTTP exchange. `RPC_TIMEOUT_MS` accepts integers from 1 through 60,000. The transport makes one attempt for each exchange so retry decisions remain visible to the durable worker. A logical ethers RPC call may involve multiple exchanges; this setting is not a total-call deadline. Five controlled HTTP-proxy tests verify short 503/drop/timeout scenarios and response loss after transaction acceptance, not indefinite outages or all remote-node behaviors.

Pagination cursors are validated metadata, not authentication tokens or tamper-proof snapshots. They bind the collection and filter and retain an upper insertion boundary, but do not freeze status changes. Authentication remains required for every page and totals request. The UI remains a demo-currency recent-record view; API totals must not be presented as customer balances or reserve proof.

Four development validators share one Docker host, so a host outage affects all of them. Node permission lists do not provide transaction confidentiality. Personal customer data should not be placed in this demo ledger.

Dependency versions are pinned and locked. Ganache and memdown are legacy development-only tools. On Node 24, Ganache may print a native transport warning and use its JavaScript fallback. A dependency lockfile is not a security audit; replacing the development VM is planned.

Real-money operation would require independent contract review, secure signer custody, governance, operational validation, and application-specific legal/compliance work. No such readiness is claimed.
