import { type TransactionReceipt } from 'ethers';

/** Compare receipt and log data without their connected provider instances. */
export function receiptData(receipt: TransactionReceipt) {
  return { ...receipt.toJSON(), type: receipt.type, logs: receipt.logs.map(log => log.toJSON()) };
}
