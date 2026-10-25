# API and signatures

The service binds to `127.0.0.1`. Send `Authorization: Bearer <API_KEY>` on `/api/` calls except the local demo bootstrap route.

| Method | Path | Behavior |
| --- | --- | --- |
| GET | `/healthz` | RPC liveness, no token required |
| GET | `/api/overview` | Recent payments, journals, audit events, chain details |
| GET | `/api/payments` | Cursor page of sanitized payment records |
| GET | `/api/journals` | Cursor page of transfer journal records |
| GET | `/api/totals` | Exact per-asset settled/review transfer volume |
| POST | `/api/payments` | Signed EOA payment: 202 new, 200 identical retry |
| POST | `/api/reconcile` | Check canonical receipts and flag mismatches |
| GET | `/api/bootstrap` | Demo-only temporary dashboard token |
| POST | `/api/demo/payment` | Demo-only signing; decimal `amount` string |

Other statuses include 400 for malformed payloads, 401 authentication, 403 Host/Origin checks, 409 conflicting instructions, 422 rejected instructions, 429 rate limits, and 503 recognized RPC transport errors. Acceptance means queued rather than settled. Poll the returned record in overview for its outcome.

JSON bodies are limited to 32 KiB. Authenticated API calls are limited to 240 per minute per loopback address. Overview returns bounded previews of up to 100 payments and 100 journal rows. Its dashboard still uses recent demo-currency data rather than the paginated or per-asset APIs.

## Cursor pages and totals

`GET /api/payments?limit=50&status=settled` and `GET /api/journals?limit=50` return `{ "items": [...], "nextCursor": "..." }`. Continue with the returned cursor; `nextCursor: null` means the end. Limits default to 50 and may be integers from 1 through 100. Payment status is optional and accepts `queued`, `broadcast`, `settled`, `failed`, or `review`. Journal pages do not accept a status filter.

Pages use descending insertion row IDs, independent of timestamps. A versioned base64url cursor binds the collection, status filter, initial upper insertion boundary, and next position. Reuse it with the same collection and status. Inserts above that initial boundary are excluded from the current scan; start without a cursor for a fresh scan. This is not a transactionally frozen snapshot of rows' changing statuses. Treat cursors as opaque pagination metadata, not credentials. Unknown query parameters, duplicate parameters, malformed/incompatible cursors, and out-of-range limits return 400.

Payment pages omit stored signatures, raw signed transactions, and internal fingerprints just as overview does. Journal pages contain transfer provenance; they do not represent wallet balances.

`GET /api/totals` returns `{ "assets": [{ "token": "0x...", "settledPayments": 1, "settledBaseUnits": "125000000", "reviewPayments": 0, "reviewBaseUnits": "0" }] }`. Asset addresses are lowercase; amounts are exact integer strings calculated from journal rows with BigInt. These are cumulative **transfer volumes**, not token balances, reserves, or valuations. Journaled payments flagged for review are excluded from settled volume and reported separately. The API does not infer token decimals or combine different assets into one money amount.

## Sign an instruction

Run this TypeScript example from the project root with the required environment variables. Never commit their values.

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
| `DB_PATH` | no | Defaults to `data/clearledger.sqlite` |
| `PORT` | no | Defaults to 4317 |

Run `npm start`. A custom DB path needs an existing parent directory. API tokens and keys must not appear in tracked files.

RPC mode bounds each HTTP exchange with `RPC_TIMEOUT_MS` and makes one transport
attempt. Durable retries happen on subsequent worker ticks. This is a per-request
bound, not an end-to-end settlement deadline; a tick can make multiple requests.

## Recovery

Broadcast records retain signed bytes and a deterministic hash. A restarted worker handles persisted broadcasts before queued instructions, first looking for the receipt, then possibly rebroadcasting identical bytes. It does not allocate another native nonce while an earlier broadcast is unresolved. Insertion order, rather than creation timestamps, controls ordering within each status group.

Missing or empty preflight revert data remains retryable even when the RPC library labels it `CALL_EXCEPTION`. That avoids treating a transport failure as a rejected payment. A real empty-data revert can consequently remain queued until investigated.

A stuck/replaced transaction can block the queue. Fee replacement and administrative resolution are not implemented. Inspect signer nonce and transaction state rather than re-signing an uncertain business payment under another ID.
