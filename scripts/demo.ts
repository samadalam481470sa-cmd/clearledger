import { randomBytes } from 'node:crypto';
import { parseUnits, id } from 'ethers';
import { compile } from './compile.ts';
import { localChain } from './local-chain.ts';
import { Store } from '../src/store.ts';
import { PaymentService } from '../src/service.ts';
import { paymentTypes } from '../src/payment.ts';
import { makeServer } from '../src/http.ts';
import { createShutdown, startWorker } from '../src/lifecycle.ts';

compile();
const chain = await localChain();
const store = new Store();
const service = new PaymentService(store, chain.provider, chain.relayer, chain.router, 31337, await chain.router.getAddress());
const apiKey = randomBytes(32).toString('hex');
let busy = false;
async function submitDemo(amount: string) {
  if (busy) throw new Error('A demo payment is in progress; retry shortly');
  busy = true;
  try {
    const block = await chain.provider.getBlock('latest');
    const payment = {
      paymentId: id(randomBytes(24).toString('hex')), payer: chain.payer.address, payee: chain.payee.address,
      token: await chain.token.getAddress(), amount: parseUnits(amount, 6).toString(),
      nonce: (await chain.router.nonces(chain.payer.address)).toString(),
      deadline: String(block!.timestamp + 3600)
    };
    const signature = await chain.payer.signTypedData(service.signingDomain, paymentTypes, payment);
    const accepted = await service.accept({ payment, signature });
    await service.tick();
    return { payment: service.publicRow(store.get(accepted.row.id)!) };
  } finally { busy = false; }
}
for (const amount of ['1250', '480', '2375.50']) await submitDemo(amount);
const port = Number(process.env.PORT ?? '4317');
const server = makeServer({ service, apiKey, port, mode: 'demo', demoPayment: submitDemo,
  demoInfo: { token: await chain.token.getAddress(), payer: chain.payer.address, payee: chain.payee.address,
    currency: 'dUSD', decimals: 6, consensus: 'Single-process local EVM', validators: 1,
    perPaymentLimit: '10000', dailyLimit: '25000' }
});
server.listen(port, '127.0.0.1', () => console.log('ClearLedger demo: http://127.0.0.1:' + port));
const worker = startWorker(() => service.tick(), { onError: () => console.error('Worker waiting for RPC recovery') });
const shutdown = createShutdown({
  stopWorker: () => worker.stop(),
  drainRequests: () => server.drainRequests(),
  closeServer: () => new Promise<void>((resolveClose, reject) => {
    server.close(error => error ? reject(error) : resolveClose());
    server.closeIdleConnections();
  }),
  closeResources: async () => { await chain.close(); store.close(); }
});
let shuttingDown = false;
function onSignal() {
  if (shuttingDown) return;
  shuttingDown = true;
  void shutdown().then(result => {
    if (result === 'closed') process.exitCode = 0;
    else {
      console.error('ClearLedger demo shutdown could not finish safely');
      process.exit(1);
    }
  });
}
process.on('SIGINT', onSignal);
process.on('SIGTERM', onSignal);

