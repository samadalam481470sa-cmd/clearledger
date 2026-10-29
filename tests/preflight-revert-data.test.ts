import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { Interface, keccak256, Wallet, type JsonRpcProvider } from 'ethers';
import { digest, domain, paymentKey, paymentSchema, type Payment } from '../src/payment.ts';
import { PaymentService } from '../src/service.ts';
import { Store } from '../src/store.ts';

// Real SQLite and canonical intent digests with synthetic router/provider
// decisions. Offline native signing in the recovery control is fixture plumbing,
// not proof of payer signatures, contract authorization or EVM execution.
const routerAddress = '0x' + '44'.repeat(20), blockHash = '0x' + 'ee'.repeat(32);
const signingDomain = domain(31337, routerAddress), signature = '0x1234';
const nativeSigner = new Wallet('0x' + '01'.repeat(32));
const iface = new Interface([
  'function settle((bytes32 paymentId,address payer,address payee,address token,uint256 amount,uint256 nonce,uint256 deadline) p,bytes signature)',
  'event PaymentSettled(bytes32 indexed paymentId,address indexed payer,address indexed payee,address token,uint256 amount,uint256 nonce)',
  'error PolicyLimit(uint256 amount)'
]);
const independentError = Object.assign(new Error('Controlled independent RPC uncertainty'), { code: 'NETWORK_ERROR' });
let store: Store, service: PaymentService, first: Payment, second: Payment, firstId: string, secondId: string;
let firstFailure: unknown, preflights: string[], routerPopulation: number, nativePopulation: number;
let signing: number, sends: number, receiptReads: number, blockReads: number, receipt: any;

function payment(n: number) {
  return paymentSchema.parse({ paymentId: '0x' + n.toString(16).padStart(64, '0'),
    payer: '0x' + (n === 1 ? 'ab' : 'cd').repeat(20), payee: '0x' + '22'.repeat(20),
    token: '0x' + 'ef'.repeat(20), amount: '125000000', nonce: '0', deadline: '2000000000' });
}
function failure(data: unknown, code: unknown = 'CALL_EXCEPTION') {
  return Object.assign(new Error('Controlled preflight failure'), {
    code, data, shortMessage: 'Controlled contract rejection'
  });
}
function snapshot() {
  return { schema: store.db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name').all(),
    rows: store.db.prepare('SELECT * FROM payments ORDER BY rowid').all(),
    audit: store.db.prepare('SELECT * FROM audit ORDER BY sequence').all(),
    sequence: store.db.prepare('SELECT * FROM sqlite_sequence ORDER BY name').all(),
    journals: store.journals(), changes: store.db.prepare('SELECT total_changes() AS changes').get() };
}
function noPreparation() {
  assert.equal(routerPopulation, 0); assert.equal(nativePopulation, 0); assert.equal(signing, 0);
  assert.equal(sends, 0); assert.equal(receiptReads, 0); assert.equal(blockReads, 0);
}
async function caughtTick() {
  try { await service.tick(); return undefined; }
  catch (error) { return error; }
}
beforeEach(() => {
  store = new Store(); first = payment(1); second = payment(2);
  firstId = store.accept(first, digest(first, signingDomain), signature).row.id;
  secondId = store.accept(second, digest(second, signingDomain), signature).row.id;
  firstFailure = failure('0xgg'); preflights = []; routerPopulation = 0; nativePopulation = 0;
  signing = 0; sends = 0; receiptReads = 0; blockReads = 0; receipt = null;
  const router = { interface: iface, connect() { return this; }, settle: {
    staticCall: async (p: Payment) => {
      const id = paymentKey(p); preflights.push(id);
      if (id === secondId) throw independentError;
      if (firstFailure !== undefined) throw firstFailure;
    },
    populateTransaction: async (p: Payment, authorization: string) => {
      routerPopulation++;
      return { to: routerAddress, value: 0, data: iface.encodeFunctionData('settle', [p, authorization]) };
    }
  } };
  const relayer = { address: nativeSigner.address,
    populateTransaction: async (request: any) => {
      nativePopulation++;
      return { ...request, type: 2, chainId: 31337, nonce: 7, gasLimit: 200000, maxFeePerGas: 2, maxPriorityFeePerGas: 1 };
    },
    signTransaction: async (request: any) => { signing++; return nativeSigner.signTransaction(request); }
  };
  const provider = {
    getTransactionReceipt: async () => { receiptReads++; return receipt; },
    broadcastTransaction: async (raw: string) => {
      sends++; const hash = keccak256(raw);
      const log = iface.encodeEventLog(iface.getEvent('PaymentSettled')!,
        [first.paymentId, first.payer, first.payee, first.token, first.amount, first.nonce]);
      receipt = { hash, blockNumber: 17, blockHash, status: 1,
        logs: [{ address: routerAddress, ...log, transactionHash: hash, blockNumber: 17, blockHash }] };
      return { hash };
    },
    getBlockNumber: async () => { blockReads++; return 17; },
    getBlock: async () => { blockReads++; return { number: 17, hash: blockHash }; }
  };
  service = new PaymentService(store, provider as unknown as JsonRpcProvider,
    relayer as unknown as Wallet, router, 31337, routerAddress);
});
afterEach(() => { store.close(); });

const uncertainData: [string, unknown][] = [
  ['malformed missing prefix', '1234'], ['malformed nonhex', '0xgg'], ['malformed odd length', '0x123'],
  ['malformed uppercase prefix', '0X1234'], ['malformed trailing newline', '0x00\n'],
  ['malformed trailing CRLF', '0x00\r\n'], ['malformed trailing space', '0x00 '],
  ['malformed leading space', ' 0x00'], ['malformed NUL suffix', '0x00\0'],
  ['undefined', undefined], ['null', null], ['empty string', ''], ['empty hex', '0x'],
  ['number', 1234], ['byte buffer', Buffer.from([0x12, 0x34])], ['array', ['0x00']], ['boxed string', new String('0x00')]
];
for (const [label, data] of uncertainData)
  test(label + ' preflight revert data remains queued and propagates the original error', async t => {
    const error = failure(data); firstFailure = error; const before = snapshot();
    const thrown = await caughtTick();
    if (thrown !== error) t.diagnostic(JSON.stringify({ originalErrorPropagated: false,
      firstStatus: store.get(firstId)!.status, secondStatus: store.get(secondId)!.status,
      failedAudits: store.events().filter(event => event.action === 'failed').length,
      preflightCalls: preflights.length, sends }));
    assert.equal(thrown, error);
    assert.deepEqual(snapshot(), before); noPreparation();
    assert.equal(await caughtTick(), error);
    assert.deepEqual(snapshot(), before); noPreparation();
    assert.deepEqual(preflights, [firstId, firstId]);
    assert.equal(store.get(firstId)!.status, 'queued'); assert.equal(store.get(secondId)!.status, 'queued');
  });

for (const [label, data] of [
  ['one zero byte', '0x00'], ['mixed hex complete bytes', '0xaB12fE'],
  ['encoded custom error', iface.encodeErrorResult('PolicyLimit', [125000000])]
] as const) test('valid ' + label + ' retains terminal rejection and permits independent work', async () => {
  firstFailure = failure(data); const evidence = store.get(firstId)!, queued = store.get(secondId)!;
  assert.equal(await caughtTick(), independentError);
  assert.deepEqual(preflights, [firstId, secondId]); noPreparation();
  const failed = store.get(firstId)!;
  assert.equal(failed.status, 'failed'); assert.equal(failed.error, 'Controlled contract rejection');
  for (const field of ['payload', 'signature', 'fingerprint', 'raw_tx', 'tx_hash'] as const)
    assert.equal(failed[field], evidence[field]);
  assert.deepEqual(store.get(secondId), queued); assert.equal(store.journals().length, 0);
  const failedEvents = store.events().filter(event => event.action === 'failed');
  assert.equal(failedEvents.length, 1); assert.equal(failedEvents[0].payment_id, firstId);
  const afterFailure = snapshot();
  assert.equal(await caughtTick(), independentError);
  assert.deepEqual(preflights, [firstId, secondId, secondId]);
  assert.deepEqual(snapshot(), afterFailure); noPreparation();
});

for (const code of ['NETWORK_ERROR', 'TIMEOUT', 'SERVER_ERROR', 'UNKNOWN_ERROR'])
  test('other-code ' + code + ' stays retryable even with valid complete-byte data', async () => {
    const error = failure('0x1234', code); firstFailure = error; const before = snapshot();
    assert.equal(await caughtTick(), error); assert.equal(await caughtTick(), error);
    assert.deepEqual(snapshot(), before); assert.deepEqual(preflights, [firstId, firstId]); noPreparation();
  });

test('a healthy retry after malformed evidence settles the original row once before independent preflight', async () => {
  const error = failure('0xgg'); firstFailure = error; const before = snapshot();
  assert.equal(await caughtTick(), error); assert.equal(await caughtTick(), error);
  assert.deepEqual(snapshot(), before); noPreparation();
  const evidence = store.get(firstId)!; firstFailure = undefined;
  assert.equal(await caughtTick(), independentError);
  assert.deepEqual(preflights, [firstId, firstId, firstId, secondId]);
  const settled = store.get(firstId)!;
  assert.equal(settled.status, 'settled');
  for (const field of ['payload', 'signature', 'fingerprint'] as const) assert.equal(settled[field], evidence[field]);
  assert.equal(store.events().filter(event => event.action === 'failed').length, 0);
  assert.equal(store.events().filter(event => event.action === 'settled').length, 1);
  assert.equal(store.journals().length, 1); assert.equal(store.journal(firstId)!.tx_hash, settled.tx_hash);
  assert.equal(routerPopulation, 1); assert.equal(nativePopulation, 1); assert.equal(signing, 1); assert.equal(sends, 1);
  assert.equal(store.get(secondId)!.status, 'queued'); assert.equal(store.get(secondId)!.raw_tx, null);
  const recovered = snapshot();
  assert.equal(await caughtTick(), independentError); assert.deepEqual(snapshot(), recovered);
  assert.equal(signing, 1); assert.equal(sends, 1); assert.equal(store.journals().length, 1);
});
