import { getAddress, isAddress, ZeroAddress, TypedDataEncoder, type TypedDataDomain } from 'ethers';
import { z } from 'zod';

const address = z.string().refine(isAddress, 'Invalid EVM address')
  .transform(getAddress).refine(a => a !== ZeroAddress, 'Zero address is forbidden');
const uint = z.string().regex(/^(0|[1-9][0-9]{0,77})$/, 'Expected integer string')
  .refine(v => /^[0-9]+$/.test(v) && BigInt(v) < 2n ** 256n, 'Exceeds uint256');
export const paymentSchema = z.object({
  paymentId: z.string().regex(/^0x[0-9a-fA-F]{64}$/).transform(s => s.toLowerCase())
    .refine(v => !/^0x0{64}$/.test(v), 'Zero payment ID'),
  payer: address, payee: address, token: address,
  amount: uint.refine(v => /^[0-9]+$/.test(v) && BigInt(v) > 0n, 'Amount must be positive'),
  nonce: uint, deadline: uint
}).strict().refine(p => p.payer !== p.payee, 'Self-payment forbidden');
export const submissionSchema = z.object({
  payment: paymentSchema,
  signature: z.string().regex(/^0x([0-9a-fA-F]{2}){0,4096}$/)
}).strict();
export type Payment = z.infer<typeof paymentSchema>;
export const paymentTypes = { Payment: [
  { name: 'paymentId', type: 'bytes32' }, { name: 'payer', type: 'address' },
  { name: 'payee', type: 'address' }, { name: 'token', type: 'address' },
  { name: 'amount', type: 'uint256' }, { name: 'nonce', type: 'uint256' },
  { name: 'deadline', type: 'uint256' }
] };
export const domain = (chainId: number, verifyingContract: string): TypedDataDomain =>
  ({ name: 'ClearLedger', version: '1', chainId, verifyingContract });
export const digest = (p: Payment, d: TypedDataDomain) => TypedDataEncoder.hash(d, paymentTypes, p);
export const paymentKey = (p: Payment) => p.payer.toLowerCase() + ':' + p.paymentId.toLowerCase();


