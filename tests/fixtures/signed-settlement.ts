import { Interface, keccak256, Transaction, Wallet } from 'ethers';
import type { Payment } from '../../src/payment.ts';

export const settleAbi = 'function settle((bytes32 paymentId,address payer,address payee,address token,uint256 amount,uint256 nonce,uint256 deadline) p,bytes signature)';
const router = new Interface([settleAbi]);
export const fixtureRelayer = new Wallet(Wallet.createRandom().privateKey);

export function signedSettlement(payment: Payment, signature: string, routerAddress: string, nonce: number) {
  const transaction = Transaction.from({ type: 2, chainId: 31337, nonce, to: routerAddress,
    data: router.encodeFunctionData('settle', [payment, signature]), gasLimit: 250000n,
    maxFeePerGas: 2n, maxPriorityFeePerGas: 1n });
  transaction.signature = fixtureRelayer.signingKey.sign(transaction.unsignedHash);
  const raw = transaction.serialized;
  return { raw, hash: keccak256(raw) };
}
