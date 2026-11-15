import { randomBytes } from 'node:crypto';
import { id, parseUnits, type Wallet } from 'ethers';
import { paymentKey, paymentTypes } from '../src/payment.ts';
import type { PaymentService } from '../src/service.ts';
import { Conflict } from '../src/store.ts';

export function createDemoPaymentSubmitter(service: PaymentService, payer: Wallet, payee: string, token: string) {
  let busy = false;
  return async (amount: string, paymentId?: string) => {
    const baseUnits = parseUnits(amount, 6).toString();
    if (paymentId !== undefined) {
      const existing = service.store.get(paymentKey({ payer: payer.address, paymentId }));
      if (existing) {
        const record = service.publicRow(existing);
        const payment = record.payment;
        if (!payment || payment.amount !== baseUnits || payment.payee.toLowerCase() !== payee.toLowerCase() ||
          payment.token.toLowerCase() !== token.toLowerCase())
          throw new Conflict('Payment ID already has different instructions');
        return { payment: record, replay: true };
      }
    }

    if (busy) throw new Error('A demo payment is in progress; retry shortly');
    busy = true;
    try {
      const block = await service.provider.getBlock('latest');
      if (!block) throw new Error('Chain unavailable');
      const payment = {
        paymentId: paymentId ?? id(randomBytes(24).toString('hex')), payer: payer.address, payee,
        token, amount: baseUnits, nonce: (await service.router.nonces(payer.address)).toString(),
        deadline: String(block.timestamp + 3600)
      };
      const signature = await payer.signTypedData(service.signingDomain, paymentTypes, payment);
      const accepted = await service.accept({ payment, signature });
      if (accepted.replay) return { payment: service.publicRow(accepted.row), replay: true };
      await service.tick();
      return { payment: service.publicRow(service.store.get(accepted.row.id)!), replay: false };
    } finally { busy = false; }
  };
}
