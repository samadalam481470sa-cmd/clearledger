# API and signatures

The service binds to `127.0.0.1`. Send `Authorization: Bearer <API_KEY>` on `/api/` calls except the local demo bootstrap route.

| Method | Path | Behavior |
| --- | --- | --- |
| GET | `/healthz` | RPC liveness, no token required |
| GET | `/api/overview` | Recent payments, journals, audit events, chain details |
| GET | `/api/payments` | Cursor page of sanitized payment records |
| GET | `/api/payments/{id}` | One sanitized local payment record by canonical ID |
| GET | `/api/journals` | Cursor page of transfer journal records |
| GET | `/api/totals` | Exact per-asset settled/review transfer volume |
| POST | `/api/payments` | EOA/ERC-1271 authorization: 202 new, 200 identical retry |
| POST | `/api/reconcile` | Check canonical receipts and flag mismatches |
| GET | `/api/bootstrap` | Demo-only temporary dashboard token |
| POST | `/api/demo/payment` | Demo-only signing; decimal `amount` string |

Other statuses include 400 for malformed payloads, 401 authentication, 403 Host/Origin checks, 409 conflicting instructions, 422 rejected instructions, 429 rate limits, 500 for recognized native SQLite errors, and 503 for recognized upstream RPC errors. Acceptance means queued rather than settled. Read payment history for its outcome; overview also requires RPC.

JSON bodies are limited to 32 KiB. Authenticated API calls are limited to 240 per minute per loopback address. Overview returns bounded previews of up to 100 payments and 100 journal rows. The dashboard uses separate 25-row payment/journal pages and per-asset totals; overview still supplies network details, recent audit events, and explicitly bounded activity counts.

## JSON request errors

Within the 32 KiB body limit, malformed JSON sent to `POST /api/payments` or `POST /api/demo/payment` returns HTTP 400 with this fixed body:

```json
{"error":"Invalid JSON request body"}
```

The response omits submitted fragments and parser positions. Parsing fails before payment acceptance or demo signing. Host, Origin and authentication checks still precede body parsing. The limit counts received bytes; an oversized body retains HTTP 422 with `Request body exceeds 32 KiB`. This change covers JSON syntax errors in these two body readers. Valid JSON still reaches existing field validation, and later service errors retain their existing classification. UTF-8 decoding behavior is unchanged.

## SQLite HTTP errors

Catch-path errors with top-level `code: "ERR_SQLITE_ERROR"` return HTTP 500 with this fixed body, after existing malformed-input/conflict classification:

```json
{"error":"Storage operation failed; check payment history before retrying"}
```

The response omits native messages, short messages and SQL/trigger details. The handler makes no automatic retry and does not infer whether acceptance committed before a later storage operation failed. Once storage is usable, inspect payment/journal history and reconcile as appropriate; replay the original signed payer/payment ID rather than creating a fresh instruction for the same transfer. For demo submissions, retry the original caller-supplied payment ID and amount; replay lasts only for the running demo’s in-memory ledger. See [demo replay](#retry-a-demo-payment-by-id).

This branch recognizes only the top-level native code. Closed-handle `ERR_INVALID_STATE`, nested codes and generic errors retain their existing paths; it is not an all-error redaction or storage-availability guarantee. The existing dashboard already treats 422/500/503 submission errors as uncertain outcomes, so this adds no client retry behavior. See [validation](VALIDATION.md#sqlite-http-errors).

## RPC error responses

Catch-path RPC failures and unusable upstream data with top-level codes `TIMEOUT`, `NETWORK_ERROR`, `SERVER_ERROR` or `BAD_DATA` return HTTP 503 with this fixed body:

```json
{"error":"Upstream RPC unavailable; check payment history before retrying"}
```

Ethers uses `BAD_DATA` for malformed receipt or block fields and unusable contract return data. Only the top-level code selects this response. A `BAD_DATA` value nested inside a `CALL_EXCEPTION` retains the contract-rejection path. A persistent malformed response can require correcting RPC or contract-deployment data before retry. [Malformed-reply verification](../STATUS.md#unusable-rpc-data-at-the-http-boundary).

Shutdown-drain 503 responses retain their distinct `Service is shutting down` body. This change adds no error fields or `Retry-After` header.

The RPC response omits upstream error messages/short messages, which can contain endpoint details. It does not establish whether a submitted payment was accepted or mined. Check authenticated `GET /api/payments`, `/api/journals`, and `/api/totals` for stored state; those collection reads can remain available during an RPC fault, while overview/health and signature acceptance/replay require upstream access.

For uncertain `POST /api/payments` outcomes, inspect history first. Once RPC/current authorization is available, retry the same signed instructions with the same payer/payment ID rather than authorizing a new ID for the same transfer. Identical replay retains the original stored signature. The HTTP handler adds no automatic retry; existing durable worker retries are separate. Local classification/redaction and controlled real-transport checks pass. [RPC error verification](VALIDATION.md#rpc-error-classification-and-redaction).

The demo dashboard checks the acknowledgement’s stored record ID, status, route, asset and exact base-unit amount before showing its receipt. Malformed or mismatched acknowledgements leave the outcome unknown and prompt a history check. [Demo acknowledgement evidence](../STATUS.md#demo-payment-acknowledgement).

### Retry a demo payment by ID

Authenticated clients can send a nonzero 32-byte `paymentId` alongside the decimal `amount` to `POST /api/demo/payment`. Use a lowercase `0x` prefix. Hex digits are normalized to lowercase. The response identifies the record as `payer-address:payment-ID`. A new instruction returns HTTP 202 and `replay: false`. Omitting the ID preserves the server-generated ID workflow.

Repeat the same ID and amount to read the result after a lost response. Equivalent decimal spellings compare by exact base-unit value. A stored match returns HTTP 200 and `replay: true` without a new signature or RPC request. Reusing the ID for a different amount returns HTTP 409. If the first request is still in progress before it commits, the demo may report that it is busy. Once the payment exists, the replay returns its stored lifecycle state.

The dashboard generates the ID before submitting. Each demo POST has a 15-second client deadline covering the response body. Expiry stops the client wait and leaves the original ID and amount available. The server may still commit the original request. Resume payment opens the saved request. Retry same payment reuses its original ID and amount, and Find this payment reads the exact stored record. An acknowledgement must match the original record ID before the dashboard opens its receipt. Starting a different payment clears the pending attempt and requires a new amount. [Dashboard retry evidence](../STATUS.md#demo-dashboard-retry) · [Timeout evidence](../STATUS.md#demo-payment-response-timeout).

Replay is limited to the running demo’s in-memory ledger. The dashboard holds the attempt in the open page and clears it when authentication is reset or the observed chain/router changes. A page reload clears its copy, and a demo restart starts a new ledger. [API replay evidence](../STATUS.md#demo-payment-replay-by-id).

## Exact payment lookup

The dashboard gives each explicit ID lookup a 15-second response deadline, including receipt of its JSON body. Expiry aborts the client request, keeps the entered ID and displays `Payment lookup timed out. Try this ID again.` The Find payment button becomes available for an explicit retry. A timed-out or cancelled response cannot later open an obsolete receipt. The server can still finish a read after the client stops waiting. [Lookup timeout verification](../STATUS.md#dashboard-payment-lookup-response-deadline).

`GET /api/payments/{id}` returns HTTP 200 with one direct public record, using the same shape as an item in `GET /api/payments`. There is no page or wrapper object. Use the record's `id`, or compute the submitted payer address in lowercase, a colon, and the submitted bytes32 payment ID in lowercase. The decoded identifier must match `0x{40 lowercase hex}:0x{64 lowercase hex}`; a literal colon or `encodeURIComponent(id)` is accepted. Decoding happens once, with no trimming or case folding.

The route accepts no query parameters, including pagination/status metadata. Such metadata returns 400 with `{"error":"Payment lookup does not accept query parameters"}`. Malformed, noncanonical or undecodable identifiers return 400 with `{"error":"Invalid payment identifier"}`. A well-formed key with no visible local record returns 404 with `{"error":"Payment not found"}`. These checks validate key syntax only; zero-valued well-formed keys are not rejected as payment authorizations would be.

Lookup requires the existing API authentication, Host/Origin and rate checks. It reads local stored state without RPC, signature revalidation, pagination or repair, so it can remain usable when RPC-dependent overview/replay fails. Stored private signatures, raw signed bytes, payload text, fingerprints and unknown fields are omitted. Corrupt stored authorization data retains the existing `payment: null` and fixed integrity warning. Noncanonical legacy keys can still be read through collection history.

A 404 describes the current local read; it cannot prove an in-flight acceptance will not commit later or establish on-chain absence. For an uncertain submission, inspect this original key and retain the same signed payer/payment ID when retrying after upstream/current-authorization recovery. The endpoint adds no automatic retry, wallet-policy recheck or chain-truth guarantee. The dashboard now provides Find a payment by ID on Overview/Payments, using one explicit read and opening the shared stored receipt snapshot even without overview metadata; see [client verification and limits](VALIDATION.md#dashboard-payment-lookup). In the CLI test, both requests can be pending while local lookup returns 404. After release, identical requests produce a 202 and a 200 replay. Valid signatures for different amounts under the same ID produce a 202 and a 409, with one settlement and journal for the accepted amount. [Lookup verification](VALIDATION.md#exact-payment-lookup) · [Concurrent submission verification](../STATUS.md#concurrent-conflicting-payment-submissions).

## Cursor pages and totals

`GET /api/payments?limit=50&status=settled` and `GET /api/journals?limit=50` return `{ "items": [...], "nextCursor": "..." }`. Continue with the returned cursor; `nextCursor: null` means the end. Limits default to 50 and may be integers from 1 through 100. Payment status is optional and accepts `queued`, `broadcast`, `settled`, `failed`, or `review`. Journal pages do not accept a status filter.

Pages use descending insertion row IDs, independent of timestamps. A versioned base64url cursor binds the collection, status filter, initial upper insertion boundary, and next position. Reuse it with the same collection and status. Inserts above that initial boundary are excluded from the current scan; start without a cursor for a fresh scan. This is not a transactionally frozen snapshot of rows' changing statuses. Treat cursors as opaque pagination metadata, not credentials. Unknown query parameters, duplicate parameters, malformed/incompatible cursors, and out-of-range limits return 400.

Payment pages omit stored signatures, raw signed transactions, and internal fingerprints just as overview does. Journal pages contain transfer provenance; they do not represent wallet balances.

`GET /api/totals` returns `{ "assets": [{ "token": "0x...", "settledPayments": 1, "settledBaseUnits": "125000000", "reviewPayments": 0, "reviewBaseUnits": "0" }] }`. Asset addresses are lowercase; amounts are exact integer strings calculated from journal rows with BigInt. These are cumulative **transfer volumes**, not token balances, reserves, or valuations. Journaled payments flagged for review are excluded from settled volume and reported separately. The API does not infer token decimals or combine different assets into one money amount.

### Journal totals integrity

One SQLite read statement checks posting relationships together with eligible totals rows. Every settled payment requires a journal; every journal must refer to an existing payment in settled/review status. A review with either recorded block field non-null also requires a journal, so reconciliation cannot hide a deleted settled journal by flagging it for review. Any non-null value counts as recorded metadata, including zero/empty/malformed values. A review with both block fields null and no journal remains a valid unposted state after a missing settlement event; it contributes no journal-derived transfer volume/count. Orphan or out-of-status journals and required missing postings invalidate the whole report using the same fixed integrity response below.

Each linked journal must also agree with its payment row on retained `tx_hash`, `block_number` and `block_hash`, using SQLite's NULL-safe value comparison. Both hashes must be text with a lowercase `0x` prefix and 64 hexadecimal digits. The digits may use either letter case, and the retained copies must agree exactly. Both block heights must be stored as SQLite integers between zero and 9,007,199,254,740,991 inclusive. Missing, malformed or unsafe inclusion values invalidate the whole report even when both rows contain the same value. Each settlement transaction hash may appear in only one posted journal across all assets and settled/review statuses. The duplicate check ignores hex letter case. A reservation without a journal contributes no volume.

Each included settled/review journal row must match its linked payment's stored JSON on token, debit account (payer), credit account (payee) and amount. The four retained strings must agree exactly. Token and account addresses require nonzero 20-byte `0x`-prefixed hex with either letter case, and payer and payee must be distinct addresses. Amounts require canonical positive decimal uint256 strings. Per-asset sums use BigInt and may exceed uint256 even though each row must fit it.

Any malformed included value, missing or unreadable posted transfer data, or disagreement makes the entire report unavailable: HTTP 200 with `{ "assets": null, "integrityError": "Stored journal data is invalid; totals are unavailable" }`. The valid `{ "assets": [...] }` response is unchanged. No raw corruption/parser details, skipped rows, partial totals, or invented zero totals are returned. This local read makes no RPC call and does not repair database, status, audit, or journal data.

The dashboard clears cached totals and their counts on this integrity report and shows a fixed unavailable warning. Transport failures instead retain explicitly stale last-good totals; a later valid report restores the display. The comparison reads the four transfer fields and accepts matching copies even when unrelated authorization fields are invalid. Coherent rewrites that preserve unique hashes and omitted payment/journal pairs can evade the report checks. Schema attestation, signature and RPC verification, balances and reserves remain outside this local reporting check. Relationship checks and aggregation share one SQLite statement read snapshot and do not open/commit/roll back a caller transaction. [Duplicate hash verification](../STATUS.md#duplicate-settlement-hashes-in-totals) · [Transfer-field verification](../STATUS.md#journal-transfer-field-consistency) · [Inclusion consistency](VALIDATION.md#journal-inclusion-consistency) · [Relationship validation](VALIDATION.md#journal-relationship-integrity) · [Historical value checks](VALIDATION.md#journal-totals-integrity). Browser appearance/events remain unverified under origin denial.

After an initial overview establishes chain/router context, the dashboard polls overview and local totals independently. Totals can keep refreshing while a later overview RPC request fails or stalls, using the last successful context and display metadata; overview failures retain their own warning and last received overview. Authentication changes, manual refresh, and observed network changes abort obsolete work. An initial overview failure still leaves dashboard context unestablished. Independent polling does not change server accounting.

Each overview and totals refresh has a 15-second client deadline, including response-body parsing. A timeout reports `Refresh response timed out`, aborts that request and preserves the last received data. The next refresh is scheduled five seconds after the client wait finishes; a later successful response clears its resource warning. Late responses are ignored. Cancellation ends the client wait and does not cancel server work. A loader that ignores cancellation can remain active when the next attempt begins. These checks do not establish browser interaction or accessibility. [Refresh deadline evidence](../STATUS.md#dashboard-resource-refresh-deadline) · [Earlier independent-refresh evidence](VALIDATION.md#independent-dashboard-refresh).

### Invalid stored payment data

Public payment records validate the stored JSON against the payment schema and require its payer/payment-ID key to match the record ID. Usable records retain the existing `payment` object, normalized in the response only, without an `integrityError` field. Invalid JSON, invalid schema data, or a mismatched key returns `payment: null` and `integrityError: "Stored payment data is invalid; verify the original authorization"`.

The eight retained record fields are `id`, `status`, `tx_hash`, `block_number`, `block_hash`, `error`, `created_at`, and `updated_at`; the row keeps its page position. Clients must allow a null payment and avoid inventing amounts, assets, parties, or authorization fields. The fixed diagnostic does not echo the stored payload or parser/schema details. The explicit public allowlist omits raw payloads, signatures, signed bytes, fingerprints, and unknown columns.

Dashboard table rows and receipt snapshots guard null payments, displaying the fixed warning and unavailable authorization/amount/route/token placeholders while preserving record identity, status, transaction/block metadata, and dates. They do not reconstruct authorization fields from an ID or journal; valid amount/asset formatting is unchanged.

Projection does not modify the database, audit trail, status, or journal. Targeted HTTP checks verify unchanged snapshots/schema and SQLite `total_changes` after GETs. Projection does not prove signature authenticity or validate retained top-level metadata/error. Explicit reconciliation may separately flag a corrupt settled authorization for review and retain its journal. Totals depend on readable, matching transfer fields in the saved payment. Targeted projection/HTTP/SSR checks and strict typecheck pass; the local full suite completed 543 cases (538 passes, five existing Windows skips, zero failures) and build passed. Linux CI passes all 543 tests, typecheck/build/count, and separate live Besu settlement/recovery acceptance. See [validation](VALIDATION.md#readable-payment-history). New cases use synthetic Store/HTTP/SSR fixtures, not new EVM verification; browser layout/events/accessibility remain unverified.

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

Distinct payment IDs can enter the queue with the same payer nonce. A successful settlement advances the router nonce, so a queued instruction that uses the earlier nonce can fail preflight before the worker signs a transaction for it. Replaying the original signed instruction returns its stored outcome after signature revalidation. If another accepted request commits the same key while the latest-block lookup is pending, an identical signed retry uses the committed record even if that lookup fails or its deadline check rejects. Different signed instructions for the same key return HTTP 409. A new key still requires a successful deadline check. [Overlap verification](../STATUS.md#acceptance-overlap-during-deadline-validation).

### Exact token transfer

The router requires the payer’s reported token balance to fall by the signed amount and the payee’s to rise by the same amount. A mismatch reverts the transfer and router state before the settlement event. The worker can reject an incompatible token outcome during preflight. The checks depend on token-reported balances. Allowlisted assets must be reviewed standard ERC-20 contracts.

This contract change applies to newly deployed routers. Each new address binds new EIP-712 signatures and the corresponding RPC database context. [Verification and limits](../STATUS.md#exact-payer-debit).

### Contract-wallet authorization and retries

For a deployed ERC-1271 wallet, set `payment.payer` to the wallet address and supply the opaque signature bytes its policy accepts for the EIP-712 payment digest. The API structurally allows 0–4096 bytes (`0x` is empty); empty bytes can be valid for a contract policy but do not authorize an EOA. Wallet-controlled token eligibility, balance, allowance, and nonce remain necessary.

Acceptance, including an identical POST replay, calls the updated router's public `isValidPaymentSignature(payment, signature)` view. It requires live RPC and current wallet authorization. The router invokes the wallet through STATICCALL, so the wallet sees the router as `msg.sender` in both this view and settlement. A signature-only view result does not reserve funds/nonces or establish policy, allowance, deadline, or settlement eligibility.

The dispatch preflight and mined execution recheck authorization. Revocation can fail a queued intent or revert an already-signed native transaction; it does not revoke a transfer already mined. After native bytes/hash are reserved, recovery reuses the exact bytes under the existing integrity checks, without policy-driven re-signing or replacement. A confirmed canonical revert consumes the relayer's native nonce and gas while leaving the wallet payment nonce unchanged and creating no wallet settlement journal.

An identical replay preserves the original stored signature rather than replacing it with newly supplied bytes. If that signature is revoked, resubmitting a new valid signature for the same intent does not rotate its authorization. Restoring wallet policy does not resurrect a terminal failed intent: replay still requires current authorization and returns its stored terminal state. That local failed record does not invalidate the underlying on-chain authorization. Use authenticated `GET /api/payments` and `/api/journals` for stored history without revalidating signatures, including while wallet authorization or RPC is unavailable.

These are existing runtime semantics. The bounded actual autonomous CLI case passed locally and in Linux CI for revocation after reservation during blocked propagation, across crash/restart and recovery; see [validation](VALIDATION.md#rpc-cli-wallet-reservation-revocation). This adds no Besu, browser, soak, SLO, or funded-production claim.

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

### RPC listener readiness

The durable RPC CLI awaits successful loopback listening before logging its actual bound port or starting the worker. A bind rejection such as `EADDRINUSE` starts no worker tick or financial transition. Cleanup destroys the provider, closes the financial Store, then releases ownership; if Store close fails, ownership remains until process exit.

Store PRAGMAs/schema and deployment context may already initialize before binding. Failed binding preserves existing logical payment, audit, and journal records, not a byte-identical file or a promise of no SQLite writes. This ordering applies only to durable RPC startup; demo pre-listen seeding and other configuration/migration behavior are unchanged. Four helper cases and the actual-CLI occupied-port/restart regression pass locally; see [validation](VALIDATION.md#rpc-listener-readiness) for full-suite evidence and publication status.

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

Before signing a new settlement, the worker requires the relayer’s gas estimate plus a 20,000 gas allowance. A transaction signed on one UTC day can execute on the next and write a fresh daily-spending slot. The latest block gas limit and, for a positive gas price, the reported pending relayer balance divided by the populated maximum fee per gas or legacy gas price must both cover the padded estimate. If a required read fails or either ceiling is too low, the worker leaves the intent queued without reserving a nonce. An earlier queued payment can delay later payments until the budget recovers or preflight rejects the authorization. The gas allowance covers the tested rollover scenario. The observed ceilings can change, and execution costs can vary. [Gas metering](https://eips.ethereum.org/EIPS/eip-2200) · [Storage access costs](https://eips.ethereum.org/EIPS/eip-2929) · [Gas budget and rollover evidence](../STATUS.md#full-gas-allowance-before-settlement-signing).

Broadcast records retain signed bytes and a deterministic hash. A restarted worker handles persisted broadcasts before queued instructions, first looking for the receipt, then possibly rebroadcasting identical bytes. It does not allocate another native nonce while an earlier broadcast is unresolved. Insertion order, rather than creation timestamps, controls ordering within each status group.

Retransmission and receipt processing both require a nonempty `0x`-prefixed, byte-aligned hex string whose `keccak256` equals the stored hash, ignoring hexadecimal letter case. Missing, malformed, or mismatched bytes leave the broadcast, exact stored evidence, audit, journals, and nonce priority intact. Operators must investigate the original evidence and chain history.

### Recovered transaction envelope

Before sending or acting on a receipt, the worker checks for a signed legacy, access-list or EIP-1559 transaction (type 0/1/2), the configured positive chain ID, recovered configured relayer, configured router destination, zero native value and exactly the ABI-encoded `settle(payment, storedSignature)` bytes. The stored submission must retain canonical fields, its payer/payment-ID key and current-domain fingerprint, using the same structural checks as queued dispatch. Invalid evidence retains the unresolved broadcast and blocks new allocation, including when the receipt reports success or revert.

The envelope check uses saved intent, so an old reservation that has reverted after wallet revocation remains eligible for receipt processing once its saved evidence agrees. Native nonce, gas limit and fees have no independent stored reference. A coherent rewrite of the saved evidence, hostile storage, false RPC data and external use of the same key are outside this comparison. [Receipt confirmation evidence](../STATUS.md#signed-transaction-check-before-receipt-confirmation) · [Earlier retransmission verification](VALIDATION.md#recovered-transaction-envelope).

The local `broadcast` status means a signed native transaction has been durably reserved; it does not prove that an upstream node received or mined it. A proxy can reject `eth_sendRawTransaction` with 503 before forwarding even though the provider attempted the call. Recovery still uses the stored hash/raw bytes, while a later authorized intent remains queued without signed native transaction bytes.

Targeted actual-CLI verification passed that unpropagated window with four automatic send attempts before force termination and four after confirmed close/SQLite reopen/restart, then healing to two settlements with consecutive native nonces, idempotent replay, and reconciliation. The case also passed Linux CI as part of all 544 passing tests; see [validation](VALIDATION.md#unpropagated-rpc-cli-reservation-recovery). This differs from earlier upstream-mined/receipt-fault CLI evidence and the instrumented helper's before-broadcast checkpoint; it is not a before-provider-call claim or a new runtime behavior. No acceptance-503 retry occurred in either the local or Linux CI scenario, so that optional test branch is not verified by these results.

A terminal settlement preflight decision requires `CALL_EXCEPTION` with lowercase `0x`, a four-byte selector and zero or more complete 32-byte ABI words. Hex digits may use either case. Unknown selectors with that shape remain eligible, including errors bubbled from the configured token. Ambiguous errors propagate unchanged, retain the queued authorization and block later native allocation. The shape check accepts any selector and does not validate arguments or authenticate the RPC reply. Genuine reverts with empty or non-ABI data can remain queued pending investigation. [Preflight evidence](../STATUS.md#settlement-preflight-revert-shape).

A stuck/replaced transaction can block the queue. Fee replacement and administrative resolution are not implemented. Inspect signer nonce and transaction state rather than re-signing an uncertain business payment under another ID.

A controlled Ganache test also exercises an unjournaled transaction whose mined block is removed while the CLI is stopped. The restarted CLI recovers the original reservation on the replacement chain and then processes its queued successor. [Crash and rollback verification](../STATUS.md#cli-recovery-after-a-rolled-back-settlement).

The receipt recovery test supports two five-minute active observation windows across an abrupt CLI restart. About every five seconds it dispatches 12 authenticated history requests together, in four groups that each read both payment IDs and the broadcast collection. Each burst checks response fields and the preserved ledger state. The dedicated `Extended receipt outage checks` workflow selects this duration with `CLEARLEDGER_LONG_RECEIPT_OUTAGE=1`. It runs when the workflow or outage test changes and supports manual dispatch for other source revisions. The windows exclude restart downtime. Each window requires a completed burst and a fresh failed receipt lookup after its five-minute boundary. These are bounded loopback observations with two stored payments. [Concurrent history verification](../STATUS.md#concurrent-history-reads-during-receipt-outage) · [Earlier extended verification](../STATUS.md#five-minute-receipt-outage-windows).

### Invalid queued authorization

Before preparing a queued transaction, the worker validates stored JSON/submission structure, payer/payment-ID identity, and the fingerprint under its current signing domain. Logical payment fields must already be canonical, as written by normal API acceptance; JSON whitespace/key order and hexadecimal fingerprint casing are immaterial. History may normalize a response copy, but dispatch never silently repairs stored fields.

An invalid queued row with both raw signed bytes and transaction hash null moves to `failed`, atomically with one audit event, using the fixed message `Stored queued authorization is invalid; verify the original authorization and chain history`. Its payload, signature, and fingerprint remain stored and private; a later independent authorization can proceed. This local decision does not establish the outcome of external chain activity.

Any queued row carrying non-null raw/hash data, including empty or partial values, blocks all new queued preparation even when it appears later in insertion order. Older broadcasts may still recover first. The worker rejects the tick with the fixed internal error `Queued payment contains transaction reservation data; inspect durable state`; the CLI retains its generic recovery log. Store also refuses to overwrite or fail that queued reservation. Investigate durable evidence and chain history before changing it; no automated repair, deletion, or replacement transaction is supplied.

Signature structure still permits opaque ERC-1271 bytes, including `0x`; router policy performs actual authorization checks. Unexpected hashing/configuration errors, atomic audit/storage failures, and uncertain RPC errors remain blocking/retryable rather than becoming invented corruption outcomes. Verification is recorded in [validation](VALIDATION.md#queued-authorization-integrity).

### Initial receipt confirmation

Once the saved authorization and signed envelope agree, a receipt can fail or settle a broadcast only after its transaction hash, safe block metadata, canonical block number and hash, and configured confirmation depth agree. The formatted receipt `type` must equal the type decoded from the saved signed transaction. Ethers 6.17 formats absent or null receipt types as `0`. That fallback can match a legacy transaction. Type-1 and type-2 transactions require their own formatted types. The receipt’s `from` and `to` must match the configured relayer and router, ignoring hexadecimal letter case. A missing or different address leaves either receipt status unresolved. Any reported contract creation address also leaves the broadcast unresolved. The signed transaction calls the router, so its receipt has no top-level creation address. Ethers 6.17 formats an omitted or null `contractAddress` as null. Supported settlement transactions use types 0, 1, or 2. Their receipts must leave `blobGasUsed` and `blobGasPrice` absent or null. A reported value in either field, including zero, leaves either receipt status unresolved. Ethers 6.17 maps omitted and null wire blob quantities to null and retains explicit quantities. The formatted receipt’s `gasUsed` must be a positive bigint at most equal to the gas limit in the saved signed transaction. An impossible value leaves the reservation unresolved for either receipt status. The receipt index must be a nonnegative safe integer. The formatted `cumulativeGasUsed` must be a bigint equal to `gasUsed` at index 0 and greater at later indexes, where previous transactions contribute gas. The signed transaction gas limit applies to `gasUsed`. The formatted effective gas price must be a nonnegative bigint. Legacy and access-list receipts must report the signed fixed gas price. A type-2 receipt must report a price between the signed maximum priority fee and the signed maximum total fee per gas, inclusive. The containing block must report a nonnegative `baseFeePerGas` no greater than the signed fee cap. The receipt price must equal the lesser of the cap and the sum of the block base fee and signed maximum priority fee. Unavailable or contradictory base fee evidence leaves either receipt status unresolved. The canonical block’s transaction list must contain the reserved hash exactly once, at the receipt index. A second occurrence, including a case variant of the same hexadecimal hash, leaves the broadcast unresolved. The formatted block must report positive bigint `gasUsed` at most equal to its bigint `gasLimit`. The worker checks these quantities on the same block it already fetched for confirmation. Status must be exactly `0` or `1`. Unknown status, invalid head data or inconsistent identity leave the intent in broadcast for retry with its signed bytes and nonce priority. Both receipt statuses require a log array and a 256-byte hexadecimal `logsBloom`. For a successful receipt, ClearLedger reconstructs the bloom from every reported log’s emitter address and topics and compares all 256 bytes. An empty log array requires an all-zero bloom. A status-0 receipt must have an empty log array because top-level reverts discard logs. A contradiction leaves the broadcast unresolved even if its hash and block position agree. A successful receipt requires a containing block timestamp at or before the signed payment deadline. Both values are in Unix seconds. The block timestamp must be a nonnegative safe integer. It is compared as a bigint against the saved uint256 deadline, and equality is permitted. A later block leaves a successful receipt unresolved. A verified revert can still resolve the broadcast after the deadline. A successful receipt must contain exactly one matching `PaymentSettled` event from the configured router before journaling. A coherent receipt with a missing expected event goes to review after confirmation.

The worker compares the configured provider’s receipt and block responses for consistency. Every reported emitter and topic contributes three bit positions derived with Keccak-256. Missing or extra bloom bits leave a broadcast unresolved. The check covers internal consistency between the reported bloom and logs. Log data, ordering and independent inclusion are outside the bloom comparison. The cumulative gas check compares fields within one receipt. The block gas check compares the containing block’s own used gas with its gas limit. Receipt and block totals can follow different metering rules. The exact gas used by earlier transactions is outside these checks. Ethers 6.17 reads receipt `effectiveGasPrice` as `gasPrice`, accepts the wire `gasPrice` alias when the primary field is absent, and defaults to zero when the selected value is absent or null. That zero fallback can satisfy an otherwise coherent zero-fee call. The type-2 fee check derives the expected price from the retained signed envelope and the reported containing block. It checks agreement between these inputs. Independent verification of the block header and fee remains outside this check. [Receipt bloom definition](https://ethereum.org/content/developers/tutorials/yellow-paper-evm/yellow-paper-berlin.pdf) · [EVM revert semantics](https://eips.ethereum.org/EIPS/eip-140) · [Solidity block timestamp](https://docs.soliditylang.org/en/latest/units-and-global-variables.html#block-and-transaction-properties) · [Containing-block deadline verification](../STATUS.md#signed-payment-deadline-and-containing-block) · [Receipt fields](https://ethereum.org/en/developers/docs/apis/json-rpc/#eth_gettransactionreceipt) · [Blob receipt fields](https://ethereum.github.io/execution-apis/api/methods/eth_getTransactionReceipt/) · [Blob gas verification](../STATUS.md#blob-gas-metadata-on-settlement-receipts) · [Typed receipt specification](https://eips.ethereum.org/EIPS/eip-2718#receipts) · [EIP-1559 fee calculations](https://eips.ethereum.org/EIPS/eip-1559) · [Block gas accounting](https://eips.ethereum.org/EIPS/eip-8037#block-level-gas-accounting) · [Block gas verification](../STATUS.md#containing-block-gas-budget) · [Type-2 fee verification](../STATUS.md#type-2-receipt-price-and-block-base-fee) · [Receipt type verification](../STATUS.md#receipt-transaction-type-binding) · [Cumulative gas verification](../STATUS.md#receipt-cumulative-gas-consistency) · [Revert receipt verification](../STATUS.md#revert-receipt-log-consistency) · [Exact receipt bloom verification](../STATUS.md#exact-receipt-log-blooms) · [Canonical transaction position verification](../STATUS.md#canonical-transaction-position) · [Receipt sender and recipient verification](../STATUS.md#receipt-sender-and-recipient-checks) · [Earlier confirmation validation](VALIDATION.md#initial-confirmation-integrity).

### Settlement-log provenance

Successful receipt processing distinguishes a coherent expected event, a missing expected event, and inconsistent evidence. A `PaymentSettled` log from the configured router is identified by its event signature, payment ID and payer topics. The entire topic array and data must match the router ABI encoding of the saved payment. This checks the payee, token, amount and nonce as well as the encoding. The event has four topics and three data words. Hexadecimal letter case is immaterial. It must also carry a valid `transactionHash`, `blockHash`, and safe integer `blockNumber` matching its enclosing receipt. Hash comparisons ignore hexadecimal letter case. When either transaction index is supplied, the formatted log `transactionIndex` and receipt `index` must be the same nonnegative safe integer. The matching event’s own `index`, formatted from RPC `logIndex`, must be a nonnegative safe integer and must occur only once in the receipt. A different log claiming the same index makes the settlement evidence inconsistent. The [Ethereum JSON-RPC reference](https://ethereum.org/en/developers/docs/apis/json-rpc/#eth_gettransactionreceipt) describes receipt logs and their transaction/block fields.

A mismatch in a candidate’s exact encoding or provenance makes the receipt inconsistent. This includes excess topics or trailing data even when a decoder returns the expected arguments. A second matching event also makes the receipt inconsistent. One conflicting candidate overrides a coherent matching event anywhere in the receipt. Initial confirmation keeps the payment in broadcast and preserves its signed bytes, hash and nonce priority. A coherent receipt with no expected event retains the review policy. The encoding comparison applies to logs from the configured router with the three identifying topics.

Reconciliation flags an already-settled payment with inconsistent event evidence for review and retains its journal, including when the block is unavailable. Review requires operator investigation even after the provider evidence is corrected. The log index check covers the expected event’s range and uniqueness within its receipt. Its actual block-wide position and independent inclusion remain outside that scope. Ethers 6.17 drops raw RPC `removed` flags when formatting receipt logs. [Log index verification](../STATUS.md#settlement-log-index-validation) · [Transaction index verification](../STATUS.md#settlement-transaction-index) · [Earlier provenance validation](VALIDATION.md#settlement-log-provenance) · [Duplicate event verification](../STATUS.md#duplicate-settlement-events-in-rpc-receipt-replies) · [Conflicting event verification](../STATUS.md#conflicting-settlement-events-for-one-payment) · [Malformed event verification](../STATUS.md#malformed-settlement-logs-with-a-known-payment-identity) · [Exact event encoding verification](../STATUS.md#exact-settlement-event-encoding) · [Duplicate log index verification](../STATUS.md#duplicate-settlement-log-indexes).

Receipt bloom reconstruction checks each log emitter and topic width and allows zero through four topics per log, matching the [EVM LOG0 through LOG4 operations](https://ethereum.github.io/execution-specs/src/ethereum/forks/gray_glacier/vm/instructions/log.py.html). This applies to every entry, including logs unrelated to the expected settlement event. A returned receipt containing an entry above that limit leaves a broadcast reservation unresolved; reconciliation flags an already recorded settlement for review and retains its journal. Valid zero-topic logs, four-topic anonymous logs and repeated topics remain valid bloom inputs. This shape check does not attest unrelated log data or provenance; the existing strict checks for the matching settlement event still apply.

### Reconciliation integrity

Reconciliation first checks the stored payment fields, payer/payment ID, signature encoding and EIP-712 fingerprint using the configured chain and router. It then verifies that the retained signed transaction hashes to the stored transaction ID and uses the same envelope checks as recovery. The type 0, 1 or 2 transaction must come from the configured relayer on the configured chain, call the configured router with zero native value and encode the exact saved payment and signature. Invalid payment or transaction evidence flags review before any RPC lookup for that row and retains the journal and stored evidence.

Reconciliation also checks the local journal before RPC. The journal must exist and exactly match the payment ID, asset, payer, payee, amount, transaction hash, block height and block hash. A missing or mismatched posting flags the payment for review without requiring a successful RPC lookup; the original journal and signed evidence remain intact. SQLite read failures propagate as storage errors and are not classified as missing postings. After successful RPC awaits, the journal is read again to detect changes made while those reads were pending.

For valid local evidence, reconciliation compares transaction and block metadata, receipt hash, sender, recipient, contract creation address, blob gas fields, transaction type and success status, canonical block number and hash, every journal field, and the configured router’s matching `PaymentSettled` event. It applies the same exact transaction position, block gas budget, effective gas price and signed deadline checks as initial confirmation. The receipt index must be a nonnegative safe integer, and the fetched block must list the stored transaction hash exactly once at that index. A repeated hash flags the affected payment for review and retains its journal. A null receipt is treated as unavailable when the recorded canonical block lists the transaction exactly once, has a coherent gas budget and timestamp at or before the signed deadline, and the journal agrees with the payment. A returned block with contradictory timestamp evidence flags a recorded settlement for review even if the receipt is unavailable. A returned block with nonpositive gas use or gas use beyond its limit contradicts the settlement even if the receipt is unavailable. A null block is also unavailable when the successful receipt matches the recorded hash and height, matches the signed transaction type and configured sender and recipient, has a safe transaction index, coherent gas totals and an effective gas price compatible with the signed fee, and contains exactly one expected settlement event with consistent provenance, a matching bloom and a matching journal. A matching block with an omitted or null base fee also leaves otherwise coherent type-2 evidence unavailable. A negative base fee, a base fee above the cap or a price inconsistent with the reported base fee flags review while retaining the journal. A returned receipt with a different formatted type, a different or absent sender or recipient, a reported contract creation address, either reported blob gas quantity, gas usage outside the signed limit, inconsistent cumulative gas, an effective gas price incompatible with the signed fee, or a bloom that is missing, malformed or differs from the reconstruction flags review even when the block is unavailable. If ethers rejects a malformed wire value before it returns a receipt or block, the lookup error still aborts the scan. For a row that passed the local checks, an RPC lookup error or unavailable evidence returns the fixed upstream HTTP 503 response and preserves the affected row and journal. Earlier review transitions in the same scan remain committed if a later lookup fails. A journal changed during a throwing RPC await may therefore need a later pass to be flagged. If both lookups return null, or returned evidence contradicts the recorded settlement, the scan still flags review. The chain checks compare responses from the configured provider. Live wallet policy, coherent rewrites of the entire evidence chain and independent proof remain outside this check. [Unavailable block verification](../STATUS.md#unavailable-block-during-reconciliation) · [Unavailable receipt verification](../STATUS.md#unavailable-receipt-during-reconciliation) · [Signed transaction verification](../STATUS.md#signed-transaction-evidence-in-reconciliation) · [Stored authorization verification](../STATUS.md#reconciliation-authorization-consistency) · [Reconciliation position verification](../STATUS.md#reconciliation-transaction-position) · [Duplicate transaction verification](../STATUS.md#duplicate-transactions-in-rpc-block-replies) · [Receipt gas evidence](../STATUS.md#receipt-gas-bound).

A completed reconciliation returns `checked`, `exceptions`, `outstandingReviews` and `at`. The first two fields describe only the settled records visited by that scan and the IDs it newly flagged. `outstandingReviews` counts all local payments whose status is `review` at the end of the scan, including pre-existing and unjournaled reviews beyond the overview preview. It is an end-of-scan count, so its membership can differ from the scan’s frozen insertion range. A later scan can report no new exceptions while outstanding reviews remain.

The count is one local SQLite read. A failed count returns the fixed storage error and retains review flags already committed by the scan. The dashboard displays the outstanding count in the reconciliation notice. Its separate journal-derived card is labeled `Journaled in review`, with guidance to use the history review filter for all review payments. Older server responses without the count display an unavailable-count message. [Report verification](../STATUS.md#outstanding-reviews-in-reconciliation-reports).

RPC exceptions propagate without marking the affected payment for review merely because a lookup failed. A scan may already have committed review flags for earlier mismatches before a later RPC failure; reconciliation is not one transaction over all rows. See [validation](VALIDATION.md#reconciliation-integrity) for the measured evidence.

SQLite block integers outside JavaScript's safe integer range are invalid provenance. The exact SQLite value remains unchanged, but JavaScript/JSON reads of that invalid metadata can be approximate; API output must not be treated as an exact representation of it.

### Concurrent reconciliation

Simultaneous reconciliation calls on one `PaymentService` instance share its active scan, with a separate result object and exception array for each caller. A joining caller receives that scan's initial insertion boundary and changing status-membership semantics, not a fresh private snapshot. Completion or rejection clears the active scan; the next call starts fresh, with no completed-result cache. RPC failure propagates to all waiters, and prior review flags already committed by the scan remain.

Every HTTP request retains its authentication/rate checks and awaits the shared scan. Disconnecting one client does not cancel the scan or remove its handler from shutdown draining. Response shapes are unchanged. Separate instances/processes are not coordinated: this is neither a distributed lease/job queue nor a transactional snapshot, overall scan deadline, or availability SLO. Verification and limits are recorded in [validation](VALIDATION.md#coalesced-reconciliation).

## Shutdown

RPC and demo entrypoints handle SIGINT and SIGTERM through one guarded, idempotent shutdown path with a default 20-second cooperative budget. New requests receive 503 and `Connection: close` while shutdown stops the listener, waits for the serialized worker's active tick, and drains actual HTTP handler promises before closing the provider/chain and SQLite. A disconnected client does not cancel a handler awaiting RPC; that operation remains part of the drain until its last possible write has completed. Each HTTP operation is registered before its handler starts, so a synchronous handler callback that requests draining is included in that drain. Completion follows the exact handler through its response or error path. [Reentrant HTTP drain verification](../STATUS.md#http-drain-requested-during-handler-entry).

A disconnected response does not establish whether acceptance committed. Inspect authenticated `GET /api/payments` history before retrying the original signed instruction. The bounded actual-CLI disconnect/restart and POSIX signal-drain results are recorded in [validation](VALIDATION.md#disconnected-acceptance-recovery).

The worker helper publishes its active promise before entering each tick callback. A later tick may synchronously request idempotent `stop()`; that promise waits for the exact current tick, keeping composed-shutdown resources open through its remaining work. The first tick still runs immediately and later intervals stay serialized. A tick must not await its own stop promise before finishing, which would wait on itself; retain it for an outside caller instead. The reentry coverage uses native timers and SQLite helpers; CLI/signal/payment and EVM/Besu evidence remain separate. See [helper validation](VALIDATION.md#reentrant-worker-shutdown).

If a drain fails or times out, no deferred resource-close step starts when it eventually completes. The entrypoint prints a fixed diagnostic and exits 1; a successful close exits naturally with code 0. An in-progress resource close or blocking JavaScript cannot be forcibly cancelled by the timer. SIGKILL, Windows force termination, and hardware failure are crash-recovery cases, not graceful shutdown. These mechanics do not guarantee an exact wall-clock exit deadline or establish production availability. Unit/HTTP checks, Linux real-SIGTERM helper integration, and bounded actual RPC CLI signal-drain/restart scenarios passed, along with build checks. See [validation](VALIDATION.md#actual-rpc-cli-recovery-and-shutdown).
