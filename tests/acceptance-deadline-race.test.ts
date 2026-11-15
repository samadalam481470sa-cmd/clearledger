import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import { Wallet, verifyTypedData, type JsonRpcProvider } from 'ethers';
import { makeServer } from '../src/http.ts';
import { paymentKey, paymentTypes, type Payment } from '../src/payment.ts';
import { PaymentService } from '../src/service.ts';
import { Store } from '../src/store.ts';

const apiKey = 'acceptance-overlap-fixture';
const routerAddress = '0x' + '44'.repeat(20);
const timestamp = 1_800_000_000;
const deadline = timestamp + 60;
const healthyBlock = { timestamp };
const faults = [
  {
    label: 'expired deadline',
    read: () => ({ timestamp: deadline + 1 }),
    firstResponse: { status: 422, body: { error: 'Authorization expired' } }
  },
  {
    label: 'missing latest block',
    read: () => null,
    firstResponse: { status: 422, body: { error: 'Chain unavailable' } }
  },
  {
    label: 'latest-block timeout',
    read() { throw Object.assign(new Error('Private fixture transport detail'), { code: 'TIMEOUT' }); },
    firstResponse: { status: 503, body: { error: 'Upstream RPC unavailable; check payment history before retrying' } }
  }
] as const;
type ReadBlock = (read: number) => { timestamp: number } | null | Promise<{ timestamp: number } | null>;

function gate() {
  let release!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  return { waiting, release };
}

// Real loopback HTTP and SQLite acceptance with offline EIP-712 verification
// and a controlled latest-block read. No EVM execution or worker dispatch.
async function withApi(readBlock: ReadBlock, run: (fixture: {
  store: Store;
  service: PaymentService;
  sign(amount: string): Promise<{ payment: Payment; signature: string }>;
  post(input: { payment: Payment; signature: string }): Promise<{ status: number; body: unknown }>;
  counts(): { blockReads: number; signatureChecks: number };
}) => Promise<void>) {
  const payer = Wallet.createRandom();
  const store = new Store();
  let blockReads = 0;
  let signatureChecks = 0;
  const provider = {
    async getBlock(tag: string) {
      assert.equal(tag, 'latest');
      return readBlock(++blockReads);
    }
  } as unknown as JsonRpcProvider;
  const router = {
    connect() { return this; },
    isValidPaymentSignature: {
      async staticCall(payment: Payment, signature: string) {
        signatureChecks++;
        return verifyTypedData(service.signingDomain, paymentTypes, payment, signature) === payment.payer;
      }
    }
  };
  const relayer = new Wallet(Wallet.createRandom().privateKey);
  const service = new PaymentService(store, provider, relayer, router, 31337, routerAddress);
  const server = makeServer({ service, apiKey, port: 0, mode: 'rpc' });
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const url = 'http://127.0.0.1:' + (server.address() as { port: number }).port + '/api/payments';
    await run({
      store, service,
      async sign(amount) {
        const payment: Payment = {
          payer: payer.address, payee: '0x' + '22'.repeat(20), token: '0x' + '33'.repeat(20),
          paymentId: '0x' + '55'.repeat(32), amount, nonce: '0', deadline: String(deadline)
        };
        return { payment, signature: await payer.signTypedData(service.signingDomain, paymentTypes, payment) };
      },
      async post(input) {
        const response = await fetch(url, {
          method: 'POST', signal: AbortSignal.timeout(5000),
          headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
          body: JSON.stringify(input)
        });
        return { status: response.status, body: await response.json() };
      },
      counts: () => ({ blockReads, signatureChecks })
    });
  } finally {
    await server.drainRequests();
    server.closeAllConnections();
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    store.close();
  }
}

for (const fault of faults) {
  for (const overlap of ['identical retry', 'conflicting instruction']) {
    test(overlap + ' resolves through accepted history despite an overlapping ' + fault.label,
      { timeout: 10000 }, async t => {
        const entered = gate();
        const released = gate();
        await withApi(async read => {
          if (read === 1) {
            entered.release();
            await released.waiting;
            return fault.read();
          }
          assert.equal(read, 2);
          return healthyBlock;
        }, async ({ store, service, sign, post, counts }) => {
          const original = await sign('125');
          const delayed = overlap === 'identical retry' ? original : await sign('375');
          const id = paymentKey(original.payment);
          const pending = post(delayed);
          try {
            await Promise.race([entered.waiting, pending.then(() => assert.fail('Expected a held latest-block read'))]);
            assert.deepEqual(store.list(), []);
            assert.deepEqual(store.events(), []);
            const accepted = await post(original);
            const committed = store.get(id);
            assert.ok(committed);
            assert.equal(committed.signature, original.signature);
            const record = service.publicRow(committed);
            assert.deepEqual(accepted, { status: 202, body: { replay: false, payment: record } });
            const audit = store.events();
            assert.equal(audit.length, 1);
            assert.equal(audit[0].action, 'accepted');
            assert.equal(audit[0].payment_id, id);
            const writes = store.db.prepare('SELECT total_changes() AS count').get();
            released.release();
            const result = await pending;
            t.diagnostic(JSON.stringify({ acceptedStatus: accepted.status, delayedStatus: result.status,
              retainedRecords: store.list().length, retainedAudits: store.events().length, ...counts() }));
            assert.deepEqual(result, overlap === 'identical retry'
              ? { status: 200, body: { replay: true, payment: record } }
              : { status: 409, body: { error: 'Payment ID already has different instructions' } });
            assert.deepEqual(store.list(), [committed]);
            assert.deepEqual(store.events(), audit);
            assert.deepEqual(store.journals(), []);
            assert.deepEqual(store.db.prepare('SELECT total_changes() AS count').get(), writes);
            assert.deepEqual(counts(), { blockReads: 2, signatureChecks: 2 });
          } finally {
            released.release();
            await Promise.allSettled([pending]);
          }
        });
      });
  }

  test('new payment retains the rejection for ' + fault.label, { timeout: 10000 }, async () => {
    await withApi(fault.read, async ({ store, sign, post, counts }) => {
      assert.deepEqual(await post(await sign('125')), fault.firstResponse);
      assert.deepEqual(store.list(), []);
      assert.deepEqual(store.events(), []);
      assert.deepEqual(store.journals(), []);
      assert.deepEqual(counts(), { blockReads: 1, signatureChecks: 1 });
    });
  });
}
