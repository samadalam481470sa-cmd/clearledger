import { randomBytes } from 'node:crypto';
import { compile } from './compile.ts';
import { createDemoPaymentSubmitter } from './demo-payment.ts';
import { localChain } from './local-chain.ts';
import { Store } from '../src/store.ts';
import { PaymentService } from '../src/service.ts';
import { makeServer } from '../src/http.ts';
import { createShutdown, startWorker } from '../src/lifecycle.ts';
import { parseAssetMetadata } from '../src/assets.ts';

const assetMetadata = parseAssetMetadata(process.env.ASSET_METADATA);
compile();
const chain = await localChain();
const store = new Store();
const service = new PaymentService(store, chain.provider, chain.relayer, chain.router, 31337, await chain.router.getAddress());
const apiKey = randomBytes(32).toString('hex');
const token = await chain.token.getAddress();
const submitDemo = createDemoPaymentSubmitter(service, chain.payer, chain.payee.address, token);
for (const amount of ['1250', '480', '2375.50']) await submitDemo(amount);
const port = Number(process.env.PORT ?? '4317');
const server = makeServer({ service, apiKey, port, mode: 'demo', demoPayment: submitDemo, assetMetadata,
  demoInfo: { token, payer: chain.payer.address, payee: chain.payee.address,
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

