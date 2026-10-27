# Threat model

This is unaudited portfolio software for test assets.

| Threat | Implemented control | Boundary |
| --- | --- | --- |
| Forged or altered payment | EIP-712 with EOA recovery or deployed-wallet ERC-1271 STATICCALL | Wallet policy can revoke validity; API/dispatch/execution checks are point-in-time |
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
| Hostile contract-wallet validation | STATICCALL and strict padded ERC-1271 magic return check | No independent gas/returndata-griefing bound or arbitrary-wallet availability guarantee |

The local demo exposes an ephemeral same-origin dashboard token and signs with a temporary server-held payer wallet. It must remain on loopback. RPC mode omits those endpoints. Neither mode is designed for direct public exposure.

ERC-1271 wallet checks originate from the router in acceptance and settlement. STATICCALL prevents the checker from changing state, but the wallet's current policy may depend on state and can change after acceptance. Both initial and replayed POSTs need live RPC/current authorization; the stored signature is never replaced on replay. Authenticated collection/history GETs do not revalidate signatures. Empty opaque bytes are structurally allowed for wallet policy; empty EOA signatures are invalid. The shared signature view establishes neither funds/nonce reservation nor overall settlement eligibility.

This wallet support uses an attributed Paris-compatible address-only adaptation of OpenZeppelin's validation pattern; local-EVM wallet tests pass in Linux CI, and the extended Besu acceptance passed a caller-bound test-wallet settlement and queued revocation after EOA quorum restoration, with shared-block reads on all four nodes. This single-host result does not establish wallet quorum-loss recovery, a Safe deployment, counterfactual ERC-6492 validation, ERC-4337 operation, multisignature governance, or protection against a wallet consuming excessive gas/return data. It still trusts RPC responses. Previous router deployments need a new deployment and ABI/address; historical bytecode hashes and dependency-audit records describe their earlier version.

RPC mode defaults to a 5,000 ms timeout per HTTP exchange. `RPC_TIMEOUT_MS` accepts integers from 1 through 60,000. The transport makes one attempt for each exchange so retry decisions remain visible to the durable worker. A logical ethers RPC call may involve multiple exchanges; this setting is not a total-call deadline. Five controlled HTTP-proxy tests verify short 503/drop/timeout scenarios and response loss after transaction acceptance, not indefinite outages or all remote-node behaviors.

The HTTP error mapping classifies catch-path RPC failures with top-level `TIMEOUT`, `NETWORK_ERROR`, or `SERVER_ERROR` as 503 with the fixed message `Upstream RPC unavailable; check payment history before retrying`, excluding their upstream message/shortMessage. Other status classification and the distinct shutdown-drain 503 body are unchanged; this does not claim every error path is redacted. The HTTP handler does not retry automatically or establish the outcome of an uncertain POST. Check stored payment/journal history before replaying the same signed payer/payment ID after RPC/current authorization recovers. Collection reads can remain available while overview/health/signature checks require RPC; concurrent upstream availability is not guaranteed. Local synthetic checks and a controlled real-transport fixture observed the mapping, preserved payment evidence, and recovered two settlements. The latter uses memory SQLite/manual ticks; evidence and limitations are recorded in [validation](VALIDATION.md#rpc-error-classification-and-redaction).

Pagination cursors are validated metadata, not authentication tokens or tamper-proof snapshots. They bind the collection and filter and retain an upper insertion boundary, but do not freeze status changes. Authentication remains required for every page and totals request. The dashboard presents transfer volume separately per asset and keeps review volume separate. These totals are not customer balances or reserve proof.

Asset symbols/decimals come only from an explicit chain-scoped operator registry or the known demo descriptor, never an automatic token/RPC lookup. Restricted ASCII symbols, unique chain/token keys, entry/decimal limits, and rejection of demo collisions bound configuration; exact BigInt formatting avoids numeric precision loss. Unknown/wrong-chain assets and metadata failing frontend display-field checks retain raw base units. The frontend rejects unknown fields and checks nonzero 20-byte hex address syntax, comparing addresses case-insensitively without EIP-55 verification; configuration startup validates/normalizes checksums.

Older demo responses may use the known six-decimal dUSD fallback only when `assetMetadata` is absent. A present empty/invalid registry never permits it. Configuration can still mislabel a token: a symbol or decimal descriptor does not prove identity, value, backing, or reserves, and does not authorize settlement. The registry/source is visible in the UI. Evidence is recorded in [validation](VALIDATION.md#configured-asset-metadata); browser appearance/interaction remains unverified.

Four development validators share one Docker host, so a host outage affects all of them. Node permission lists do not provide transaction confidentiality. Personal customer data should not be placed in this demo ledger.

Dependency versions are pinned and locked. The [October 26 maintenance record](DEPENDENCIES.md) documents patched Zod/Vite/compiler-helper versions, audit classification limits, and 33 remaining affected-package entries in Ganache or its bundled tree, including five critical findings. Ganache and memdown are legacy development-only tools. On Node 24, Ganache may print a native transport warning and use its JavaScript fallback. A dependency lockfile is not a security audit; replacing the development VM is planned.

Real-money operation would require independent contract review, secure signer custody, governance, operational validation, and application-specific legal/compliance work. No such readiness is claimed.
