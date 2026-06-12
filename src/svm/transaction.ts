import {
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
} from "@solana/kit";

/**
 * Check whether the fee payer address appears in any instruction's account
 * list of a base64-encoded wire transaction.
 *
 * A facilitator that sponsors fees must never let its fee payer account be
 * passed into instructions, where a malicious program could mutate or drain
 * it. Verification should reject such transactions outright.
 *
 * @param transactionBase64 - Wire transaction, base64 encoded. May be partially signed.
 * @param feePayer - Fee payer address to scan for.
 * @returns True when the fee payer is referenced by any instruction.
 */
export function feePayerAppearsInInstructionAccounts(
  transactionBase64: string,
  feePayer: string,
): boolean {
  const wireBytes = getBase64Encoder().encode(transactionBase64);
  const transaction = getTransactionDecoder().decode(wireBytes);
  const compiled = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes);

  if (!("instructions" in compiled) || !("staticAccounts" in compiled)) {
    throw new Error("Unsupported transaction message version: no instruction list.");
  }

  const staticAccounts: readonly string[] = (compiled.staticAccounts ?? []).map(a => a.toString());
  for (const instruction of compiled.instructions ?? []) {
    for (const accountIndex of instruction.accountIndices ?? []) {
      if (staticAccounts[accountIndex] === feePayer) return true;
    }
  }
  return false;
}
