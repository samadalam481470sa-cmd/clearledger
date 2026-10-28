# API and signatures

The service binds to `127.0.0.1`. Send `Authorization: Bearer <API_KEY>` on `/api/` calls except the local demo bootstrap route.

| Method | Path | Behavior |
| --- | --- | --- |
| GET | `/healthz` | RPC liveness, no token required |
| GET | `/api/overview` | Recent payments, journals, audit events, chain details |
| GET | `/api/payments` | Cursor page of sanitized payment records |
| GET | `/api/journals` | Cursor page of transfer journal records |
| GET | `/api/totals` | Exact per-asset settled/review transfer volume |
| POST | `/api/payments` | EOA/ERC-1271 authorization: 202 new, 200 identical retry |
| POST | `/api/reconcile` | Check canonical receipts and flag mismatches |
| GET | `/api/bootstrap` | Demo-only temporary dashboard token |
| POST | `/api/demo/payment` | Demo-only signing; decimal `amount` string |

Other statuses include 400 for malformed payloads, 401 authentication, 403 Host/Origin checks, 409 conflicting instructions, 422 rejected instructions, 429 rate limits, and 503 for recognized upstream RPC errors. Acceptance means queued rather than settled. Read payment history for its outcome; overview also requires RPC.

JSON bodies are limited to 32 KiB. Authenticated API calls are limited to 240 per minute per loopback address. Overview returns bounded previews of up to 100 payments and 100 journal rows. The dashboard uses separate 25-row payment/journal pages and per-asset totals; overview still supplies network details, recent audit events, and explicitly bounded activity counts.

## RPC error responses

Catch-path RPC failures with top-level codes `TIMEOUT`, `NETWORK_ERROR`, or `SERVER_ERROR` return HTTP 503 with this fixed body, preserving the other existing status classifications:

```json
{"error":"Upstream RPC unavailable; check payment history before retrying"}
```

Shutdown-drain 503 responses retain their distinct `Service is shutting down` body. This change adds no error fields or `Retry-After` header.

The RPC response omits upstream error messages/short messages, which can contain endpoint details. It does not establish whether a submitted payment was accepted or mined. Check authenticated `GET /api/payments`, `/api/journals`, and `/api/totals` for stored state; those collection reads can remain available during an RPC fault, while overview/health and signature acceptance/replay require upstream access.

For uncertain `POST /api/payments` outcomes, inspect history first. Once RPC/current authorization is available, retry the same signed instructions with the same payer/payment ID rather than authorizing a new ID for the same transfer. Identical replay retains the original stored signature. The demo signing endpoint does not provide durable client replay keys. The HTTP handler adds no automatic retry; existing durable worker retries are separate. Local classification/redaction and controlled real-transport checks pass; evidence and limitations are recorded in [validation](VALIDATION.md#rpc-error-classification-and-redaction).

## Cursor pages and totals

`GET /api/payments?limit=50&status=settled` and `GET /api/journals?limit=50` return `{ "items": [...], "nextCursor": "..." }`. Continue with the returned cursor; `nextCursor: null` means the end. Limits default to 50 and may be integers from 1 through 100. Payment status is optional and accepts `queued`, `broadcast`, `settled`, `failed`, or `review`. Journal pages do not accept a status filter.

Pages use descending insertion row IDs, independent of timestamps. A versioned base64url cursor binds the collection, status filter, initial upper insertion boundary, and next position. Reuse it with the same collection and status. Inserts above that initial boundary are excluded from the current scan; start without a cursor for a fresh scan. This is not a transactionally frozen snapshot of rows' changing statuses. Treat cursors as opaque pagination metadata, not credentials. Unknown query parameters, duplicate parameters, malformed/incompatible cursors, and out-of-range limits return 400.

Payment pages omit stored signatures, raw signed transactions, and internal fingerprints just as overview does. Journal pages contain transfer provenance; they do not represent wallet balances.

`GET /api/totals` returns `{ "assets": [{ "token": "0x...", "settledPayments": 1, "settledBaseUnits": "125000000", "reviewPayments": 0, "reviewBaseUnits": "0" }] }`. Asset addresses are lowercase; amounts are exact integer strings calculated from journal rows with BigInt. These are cumulative **transfer volumes**, not token balances, reserves, or valuations. Journaled payments flagged for review are excluded from settled volume and reported separately. The API does not infer token decimals or combine different assets into one money amount.

### Journal totals integrity

Each included settled/review journal row must have a nonzero 20-byte `0x`-prefixed hex token address and a canonical positive decimal uint256 amount. Address hex letters may use either case; this is syntax validation, not EIP-55 checksum validation. Per-asset sums use BigInt and may exceed uint256 even though each row must fit it.

Any malformed included value makes the entire report unavailable: HTTP 200 with `{ "assets": null, "integrityError": "Stored journal data is invalid; totals are unavailable" }`. The valid `{ "assets": [...] }` response is unchanged. No raw corruption/parser details, skipped rows, partial totals, or invented zero totals are returned. This local read makes no RPC call and does not repair database, status, audit, or journal data.

The dashboard clears cached totals and their counts on this integrity report and shows a fixed unavailable warning. Transport failures instead retain explicitly stale last-good totals; a later valid report restores the display. These checks do not match every journal field to a payment or detect missing, orphaned, valid-but-wrong, or coherently tampered records. They do not prove signatures/RPC data, balances, or reserves. Verification and limits are recorded in [validation](VALIDATION.md#journal-totals-integrity). Browser appearance/events remain unverified under origin denial.

After an initial overview establishes chain/router context, the dashboard polls overview and local totals independently. Totals can keep refreshing while a later overview RPC request fails or stalls, using the last successful context and display metadata; overview failures retain their own warning and last received overview. Authentication changes, manual refresh, and observed network changes abort obsolete work. An initial overview failure still leaves dashboard context unestablished. Independent polling does not change server accounting. Verification details and limits are recorded in the linked validation section; browser appearance/events remain unverified under origin denial. See [validation](VALIDATION.md#independent-dashboard-refresh).

### Invalid stored payment data

Public payment records validate the stored JSON against the payment schema and require its payer/payment-ID key to match the record ID. Usable records retain the existing `payment` object, normalized in the response only, without an `integrityError` field. Invalid JSON, invalid schema data, or a mismatched key returns `payment: null` and `integrityError: "Stored payment data is invalid; verify the original authorization"`.

The eight retained record fields are `id`, `status`, `tx_hash`, `block_number`, `block_hash`, `error`, `created_at`, and `updated_at`; the row keeps its page position. Clients must allow a null payment and avoid inventing amounts, assets, parties, or authorization fields. The fixed diagnostic does not echo the stored payload or parser/schema details. The explicit public allowlist omits raw payloads, signatures, signed bytes, fingerprints, and unknown columns.

Dashboard table rows and receipt snapshots guard null payments, displaying the fixed warning and unavailable authorization/amount/route/token placeholders while preserving record identity, status, transaction/block metadata, and dates. They do not reconstruct authorization fields from an ID or journal; valid amount/asset formatting is unchanged.

Projection does not modify the database, audit trail, status, or journal. Targeted HTTP checks verify unchanged snapshots/schema and SQLite `total_changes` after GETs. Projection does not prove signature authenticity or validate retained top-level metadata/error. Explicit reconciliation may separately flag a corrupt settled authorization for review while retaining its journal and readable totals. Targeted projection/HTTP/SSR checks and strict typecheck pass; the local full suite completed 543 cases (538 passes, five existing Windows skips, zero failures) and build passed. Linux CI passes all 543 tests, typecheck/build/count, and separate live Besu settlement/recovery acceptance. See [validation](VALIDATION.md#readable-payment-history). New cases use synthetic Store/HTTP/SSR fixtures, not new EVM verification; browser layout/events/accessibility remain unverified.

## Asset display metadata

Optional `ASSET_METADATA` supplies a JSON array of operator-configured descriptors, for example:

```json
[{"chainId":31337,"token":"0x1111111111111111111111111111111111111111","symbol":"TST","decimals":18}]
```

The strict registry allows at most 100 entries. Each has a positive safe-integer chain ID, valid nonzero EVM token address normalized to checksum form, unique chain/token pair, integer decimals from 0 through 255, and a 1–16-character ASCII symbol starting with a letter and otherwise using letters, digits, `.`, `_`, or `-`. Invalid configuration is rejected. Demo mode explicitly adds its known token as six-decimal `dUSD`; a configured collision with that chain/token is rejected, and active-chain entries including the demo descriptor must not exceed 100.

`GET /api/overview` returns the active chain's `assetMetadata` array with `source: "configured"` or `"demo"` on each descriptor. The dashboard displays the registry/source and formats known amounts with exact BigInt arithmetic. Unknown/wrong-chain assets and metadata failing its display-field checks retain raw base units. The frontend rejects unknown fields and checks nonzero 20-byte hex address syntax, comparing addresses case-insensitively; it does not verify EIP-55 casing. Configuration startup performs checksum validation/normalization.

For compatibility, an older demo response that omits `assetMetadata` can still format its explicitly known demo token as six-decimal dUSD. A present empty or invalid registry never enables that fallback.

`/api/totals` and payment amounts remain exact base-unit strings. No token metadata is fetched from RPC, and no prices, valuations, or reserve claims are inferred. Configured symbols/decimals are operator assertions rather than independent token verification. Evidence and limitations are recorded in [validation](VALIDATION.md#configured-asset-metadata).

## Sign an instruction

The following example uses an EOA. Run it from the project root with the required environment variables. Never commit their values.

```ts
import { Wallet, id } from 'ethers';
import { domain, paymentTypes } from './src/payment.ts';

const payer = new Wallet(process.env.PAYER_PRIVATE_KEY!);
const payment = {
  paymentId: id('invoice-2026-001'),
  payer: payer.address,
  payee: process.env.PAYEE_ADDRESS!,
  token: process.env.TOKEN_ADDRESS!,
  amount: '125000000', // 125 dUSD at six decimals
  nonce: '0', // Read SettlementRouter.nonces(payer.address).
  deadline: String(Math.floor(Date.now() / 1000) + 3600)
};
const signature = await payer.signTypedData(
  domain(Number(process.env.CHAIN_ID), process.env.ROUTER_ADDRESS!),
  paymentTypes,
  payment
);
const response = await fetch('http://127.0.0.1:4317/api/payments', {
  method: 'POST',
  headers: {
    Authorization: 'Bearer ' + process.env.API_KEY,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({ payment, signature })
});
console.log(response.status, await response.json());
```

Read the current payer nonce before creating each authorization. The payer needs token eligibility, sufficient balance, and an approved router allowance. The API allows deadlines no more than seven days in the future. The router itself enforces expiry.

### Contract-wallet authorization and retries

For a deployed ERC-1271 wallet, set `payment.payer` to the wallet address and supply the opaque signature bytes its policy accepts for the EIP-712 payment digest. The API structurally allows 0–4096 bytes (`0x` is empty); empty bytes can be valid for a contract policy but do not authorize an EOA. Wallet-controlled token eligibility, balance, allowance, and nonce remain necessary.

Acceptance, including an identical POST replay, calls the updated router's public `isValidPaymentSignature(payment, signature)` view. It requires live RPC and current wallet authorization. The router invokes the wallet through STATICCALL, so the wallet sees the router as `msg.sender` in both this view and settlement. A signature-only view result does not reserve funds/nonces or establish policy, allowance, deadline, or settlement eligibility.

The dispatch preflight and mined execution recheck authorization. Revocation can fail a queued intent or revert an already-signed native transaction; it does not revoke a transfer already mined. After native bytes/hash are reserved, recovery reuses the exact bytes under the existing integrity checks, without policy-driven re-signing or replacement. A confirmed canonical revert consumes the relayer's native nonce and gas while leaving the wallet payment nonce unchanged and creating no wallet settlement journal.

An identical replay preserves the original stored signature rather than replacing it with newly supplied bytes. If that signature is revoked, resubmitting a new valid signature for the same intent does not rotate its authorization. Restoring wallet policy does not resurrect a terminal failed intent: replay still requires current authorization and returns its stored terminal state. That local failed record does not invalidate the underlying on-chain authorization. Use authenticated `GET /api/payments` and `/api/journals` for stored history without revalidating signatures, including while wallet authorization or RPC is unavailable.

These are existing runtime semantics. The bounded actual autonomous CLI case passed locally for revocation after reservation during blocked propagation, across crash/restart and recovery; regular CI remains pending; see [validation](VALIDATION.md#rpc-cli-wallet-reservation-revocation). This adds no Besu, browser, soak, SLO, or funded-production claim.

Existing deployments require a new router deployment and updated ABI/address; do not reuse prior bytecode hashes as evidence for this version. This is generic deployed-wallet validation, without demonstrated Safe deployment, ERC-6492 counterfactual wallets, ERC-4337 operation, or multisignature governance. See [validation](VALIDATION.md#erc-1271-authorization) for measured evidence and limits.

## RPC mode

Set environment variables in the shell. The app does not automatically load `.env` files.

| Variable | Required | Meaning |
| --- | --- | --- |
| `RPC_URL` | yes | Development-chain JSON-RPC endpoint |
| `RPC_TIMEOUT_MS` | no | HTTP exchange timeout; integer 1–60000 ms, defaults to 5000 |
| `CHAIN_ID` | yes | Expected chain ID; startup rejects mismatch |
| `ROUTER_ADDRESS` | yes | Deployed SettlementRouter |
| `RELAYER_PRIVATE_KEY` | yes | Development relayer with gas and SETTLER_ROLE |
| `API_KEY` | yes | At least 32 characters; use high-entropy random bytes |
| `CONFIRMATIONS` | no | Positive integer; defaults to 2 |
| `ASSET_METADATA` | no | Strict JSON array of chain/token/symbol/decimals descriptors; display only |
| `DB_PATH` | no | Regular local file; defaults to `data/clearledger.sqlite`, with RPC ownership and deployment-context checks |
| `PORT` | no | Defaults to 4317 |

Run `npm start`. A custom DB path needs an existing parent directory. API tokens and keys must not appear in tracked files.

### RPC database ownership

After read-only chain/router/role checks, the actual RPC CLI acquires ownership before opening Store, binding context, or starting HTTP/worker activity. It resolves the financial file's canonical path and uses that path for Store, so main-file symlink aliases share ownership. RPC `DB_PATH` rejects `:memory:`, `file:` URIs, nonregular files, and hard-linked financial files.

Ownership uses the persistent `${canonicalPath}.worker-lock.sqlite` sidecar with SQLite `journal_mode=DELETE` and a lifetime `BEGIN EXCLUSIVE` transaction. The sidecar remains after release or a crash; its presence alone does not mean an owner is active. There is no PID/TTL expiration or stale-file deletion. **Do not delete or rename the sidecar while an owner is running.** Restart reuses it; SQLite/OS locking controls acquisition within and across cooperating processes.

Graceful shutdown drains the worker/HTTP operations and closes Store before releasing ownership last. Startup cleanup follows that ordering too; if cleanup cannot safely close the financial connection, ownership remains until process exit. A crash/forced termination releases the process's OS locks without making that termination graceful.

This is one cooperating RPC CLI per canonical database on a supported local filesystem, not a distributed or global relayer-key lease. Different databases using the same relayer key, malicious file replacement/hard-link races, and network filesystems are unsupported. Direct Store/PaymentService embeddings must explicitly acquire ownership and use its canonical path; the in-memory demo is unchanged. Local checks and Linux CI pass, including all 21 ownership cases and the actual CLI scenario; Windows has explicit platform skips. See [validation](VALIDATION.md#rpc-database-ownership).

### RPC database context

Before starting HTTP or the worker, the RPC entrypoint binds SQLite to a version-1 tuple: positive safe-integer chain ID, normalized nonzero genesis hash read from actual block 0 (which must report number 0), and normalized nonzero router/relayer addresses. The binding stores no RPC URL, API key, or private key. RPC endpoints and API keys can change while this tuple remains identical.

A `BEGIN IMMEDIATE` transaction manages the STRICT `deployment_context` singleton. An unbound database initializes only when its payment, journal, and audit tables are all empty. An identical-context restart is a no-op. Mismatched, malformed, or extra stored context rows, and a nonempty unbound legacy database, refuse startup with a fixed error rather than adopting or rebinding records.

An intentional deployment/relayer change requires a separate `DB_PATH` and review of legacy or pending data; no automatic migration, deletion, or rebind is provided. Store construction applies its existing PRAGMAs/schema DDL before context binding, so refusal preserves logical records/context rather than guaranteeing an unchanged database-file hash. This check applies to `src/server.ts`; direct `Store`/`PaymentService` embeddings must explicitly bind their deployment context. The ephemeral in-memory demo is unchanged.

The tuple still trusts RPC data and does not distinguish forks sharing a genesis, same-address code upgrades, database tampering, or multiple worker owners. Evidence and limitations are recorded in [validation](VALIDATION.md#rpc-database-deployment-context).

RPC mode bounds each HTTP exchange with `RPC_TIMEOUT_MS` and makes one transport
attempt. Durable retries happen on subsequent worker ticks. This is a per-request
bound, not an end-to-end settlement deadline; a tick can make multiple requests.

## Recovery

Broadcast records retain signed bytes and a deterministic hash. A restarted worker handles persisted broadcasts before queued instructions, first looking for the receipt, then possibly rebroadcasting identical bytes. It does not allocate another native nonce while an earlier broadcast is unresolved. Insertion order, rather than creation timestamps, controls ordering within each status group.

When no receipt exists for the stored hash, retransmission requires a nonempty `0x`-prefixed, byte-aligned hex string whose `keccak256` equals that hash, ignoring hexadecimal letter case. Missing, malformed, or mismatched raw evidence stays broadcast with its exact stored evidence, audit/journals, and nonce priority unchanged; it is not sent, replaced, repaired, or made terminal. Operators must investigate the original evidence and chain history. This gate controls retransmission only: a present receipt follows the existing confirmation and Store finalization requirements.

Byte/hash coherence does not decode the transaction or verify its signer, destination, chain, calldata, or payment authorization. It is not independent RPC proof, tamper-proof storage, or protection against multiple databases sharing one relayer key. Verification and limits are recorded in [validation](VALIDATION.md#recovered-transaction-hash-binding).

The local `broadcast` status means a signed native transaction has been durably reserved; it does not prove that an upstream node received or mined it. A proxy can reject `eth_sendRawTransaction` with 503 before forwarding even though the provider attempted the call. Recovery still uses the stored hash/raw bytes, while a later authorized intent remains queued without signed native transaction bytes.

Targeted actual-CLI verification passed that unpropagated window with four automatic send attempts before force termination and four after confirmed close/SQLite reopen/restart, then healing to two settlements with consecutive native nonces, idempotent replay, and reconciliation. The case also passed Linux CI as part of all 544 passing tests; see [validation](VALIDATION.md#unpropagated-rpc-cli-reservation-recovery). This differs from earlier upstream-mined/receipt-fault CLI evidence and the instrumented helper's before-broadcast checkpoint; it is not a before-provider-call claim or a new runtime behavior. No acceptance-503 retry occurred in either the local or Linux CI scenario, so that optional test branch is not verified by these results.

Missing or empty preflight revert data remains retryable even when the RPC library labels it `CALL_EXCEPTION`. That avoids treating a transport failure as a rejected payment. A real empty-data revert can consequently remain queued until investigated.

A stuck/replaced transaction can block the queue. Fee replacement and administrative resolution are not implemented. Inspect signer nonce and transaction state rather than re-signing an uncertain business payment under another ID.

### Invalid queued authorization

Before preparing a queued transaction, the worker validates stored JSON/submission structure, payer/payment-ID identity, and the fingerprint under its current signing domain. Logical payment fields must already be canonical, as written by normal API acceptance; JSON whitespace/key order and hexadecimal fingerprint casing are immaterial. History may normalize a response copy, but dispatch never silently repairs stored fields.

An invalid queued row with both raw signed bytes and transaction hash null moves to `failed`, atomically with one audit event, using the fixed message `Stored queued authorization is invalid; verify the original authorization and chain history`. Its payload, signature, and fingerprint remain stored and private; a later independent authorization can proceed. This local decision does not establish the outcome of external chain activity.

Any queued row carrying non-null raw/hash data, including empty or partial values, blocks all new queued preparation even when it appears later in insertion order. Older broadcasts may still recover first. The worker rejects the tick with the fixed internal error `Queued payment contains transaction reservation data; inspect durable state`; the CLI retains its generic recovery log. Store also refuses to overwrite or fail that queued reservation. Investigate durable evidence and chain history before changing it; no automated repair, deletion, or replacement transaction is supplied.

Signature structure still permits opaque ERC-1271 bytes, including `0x`; router policy performs actual authorization checks. Unexpected hashing/configuration errors, atomic audit/storage failures, and uncertain RPC errors remain blocking/retryable rather than becoming invented corruption outcomes. Verification is recorded in [validation](VALIDATION.md#queued-authorization-integrity).

### Initial receipt confirmation

A receipt can fail or settle a broadcast only after its transaction hash, safe block metadata, canonical block number/hash, and configured confirmation depth agree. Status must be exactly `0` or `1`; unknown status, invalid head data, or inconsistent/malformed identity leaves the intent in broadcast for retry, retaining its signed bytes and nonce priority. Missing or non-array success logs are also retryable. A valid success-log array must contain the configured router's matching `PaymentSettled` event before journaling; an explicit valid empty array or otherwise missing expected event goes to review after confirmation.

These checks still trust RPC responses; they are not independent proofs or a finality guarantee. See [validation](VALIDATION.md#initial-confirmation-integrity) for measured evidence and limits.

### Settlement-log provenance

Successful receipt processing distinguishes a coherent expected event, a missing expected event, and inconsistent provenance. A decoded `PaymentSettled` from the configured router with every expected payment field must also carry a valid `transactionHash`, `blockHash`, and safe integer `blockNumber` matching its enclosing receipt. Hash comparisons ignore hexadecimal letter case. The [Ethereum JSON-RPC reference](https://ethereum.org/en/developers/docs/apis/json-rpc/#eth_gettransactionreceipt) describes receipt logs and their transaction/block fields.

Any otherwise matching candidate with missing, invalid, or mismatched provenance makes the receipt inconsistent, even if another coherent candidate appears before or after it. Initial confirmation keeps such an intent broadcast, preserving signed bytes/hash and native-nonce priority without journaling. A coherent receipt with no expected event retains the review policy. Unrelated/nonmatching malformed logs do not poison a coherent expected event.

Reconciliation flags an already-settled payment with inconsistent log provenance for review and retains its journal without reversal; repairing RPC evidence does not automatically restore review to settled. This does not add transaction-index/log-index validation or rely on a raw RPC `removed` field, which the ethers 6.17 receipt-formatting path drops. RPC data remains trusted rather than independently proved. Local checks and Linux CI pass, including all 501 tests, typecheck/build/count, and the separate live Besu acceptance. See [validation](VALIDATION.md#settlement-log-provenance). The corrupted-transport cases use Ganache/in-memory SQLite/manual ticks; the Besu run separately validates ordinary settlement/recovery through the strengthened guard.

### Reconciliation integrity

Reconciliation validates stored payment/ID/transaction/block metadata and compares receipt identity/status, the canonical block's number/hash, every journal field, and a matching `PaymentSettled` event emitted by the configured router. Mismatches or missing receipt/block data conservatively flag the payment for review while retaining its journal; they do not reverse accounting or independently prove a reorganization.

RPC exceptions propagate without marking the affected payment for review merely because a lookup failed. A scan may already have committed review flags for earlier mismatches before a later RPC failure; reconciliation is not one transaction over all rows. See [validation](VALIDATION.md#reconciliation-integrity) for the measured evidence.

SQLite block integers outside JavaScript's safe integer range are invalid provenance. The exact SQLite value remains unchanged, but JavaScript/JSON reads of that invalid metadata can be approximate; API output must not be treated as an exact representation of it.

## Shutdown

RPC and demo entrypoints handle SIGINT and SIGTERM through one guarded, idempotent shutdown path with a default 20-second cooperative budget. New requests receive 503 and `Connection: close` while shutdown stops the listener, waits for the serialized worker's active tick, and drains actual HTTP handler promises before closing the provider/chain and SQLite. A disconnected client does not cancel a handler awaiting RPC; that operation remains part of the drain until its last possible write has completed.

If a drain fails or times out, no deferred resource-close step starts when it eventually completes. The entrypoint prints a fixed diagnostic and exits 1; a successful close exits naturally with code 0. An in-progress resource close or blocking JavaScript cannot be forcibly cancelled by the timer. SIGKILL, Windows force termination, and hardware failure are crash-recovery cases, not graceful shutdown. These mechanics do not guarantee an exact wall-clock exit deadline or establish production availability. Unit/HTTP checks, Linux real-SIGTERM helper integration, and bounded actual RPC CLI signal-drain/restart scenarios passed, along with build checks. See [validation](VALIDATION.md#actual-rpc-cli-recovery-and-shutdown).
