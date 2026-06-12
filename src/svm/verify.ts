import { findAssociatedTokenAccount } from "./ata.js";
import { TOKEN_2022_PROGRAM_ADDRESS, TOKEN_PROGRAM_ADDRESS } from "./constants.js";
import {
  checkReturnDataMagic,
  checkTimelock,
  countProgramInvocations,
  parseBigIntLike,
  parseTimelock,
  parseTokenAmountFromParsedAccount,
} from "./helpers.js";
import type { SimulationReturnData } from "./helpers.js";

/** Subset of an account info RPC response used here. */
export interface SvmAccountInfoResponse {
  value: {
    executable?: boolean;
    owner?: unknown;
    lamports?: unknown;
    data?: unknown;
  } | null;
}

/** Subset of a simulateTransaction RPC response used here. */
export interface SvmSimulationResponse {
  value: {
    err: unknown;
    logs?: readonly string[] | null;
    returnData?: SimulationReturnData | null;
    accounts?: readonly ({ lamports?: unknown; data?: unknown } | null)[] | null;
  };
}

/**
 * Minimal structural slice of a Solana RPC client.
 *
 * An `Rpc<SolanaRpcApi>` from `@solana/kit` (`createSolanaRpc(...)`)
 * satisfies this shape. Cast with `rpc as unknown as SvmRpcLike` if your
 * client's branded types resist structural assignment.
 */
export interface SvmRpcLike {
  getAccountInfo(
    address: string,
    config?: { encoding?: string; commitment?: string },
  ): { send(): Promise<SvmAccountInfoResponse> };
  simulateTransaction(
    transaction: string,
    config?: {
      sigVerify?: boolean;
      replaceRecentBlockhash?: boolean;
      commitment?: string;
      encoding?: string;
      accounts?: { encoding?: string; addresses: readonly string[] };
    },
  ): { send(): Promise<SvmSimulationResponse> };
}

export interface VerifyAgenticProgramPaymentParams {
  /** RPC client used for account lookups and simulation. */
  rpc: SvmRpcLike;
  /** Fully signed transaction in base64 wire encoding. The caller signs with its fee payer key first. */
  signedTransaction: string;
  /** Sponsoring fee payer address. Its lamports must be conserved by the simulation. */
  feePayer: string;
  /** Program id treated as the payer. Must be an executable account on chain. */
  payerProgram: string;
  /** Payment token mint. Required unless `recipientTokenAccount` is given. */
  mint?: string | undefined;
  /** Recipient owner address. Required unless `recipientTokenAccount` is given. */
  payTo?: string | undefined;
  /** Explicit recipient token account. Skips the mint lookup and ATA derivation. */
  recipientTokenAccount?: string | undefined;
  /** Minimum acceptable balance increase of the recipient token account, in base units. */
  minAmount: bigint;
  /** Optional unix-second bounds checked against the local clock. */
  timelock?:
    | {
        validAfter?: number | bigint | string | undefined;
        validBefore?: number | bigint | string | undefined;
      }
    | undefined;
  /** Clock override in unix seconds. Defaults to the system clock. */
  nowSeconds?: bigint | undefined;
}

export type AgenticVerificationFailureReason =
  | "payer_not_executable_program"
  | "timelock_not_started"
  | "timelock_expired"
  | "mint_unknown_token_program"
  | "simulation_failed"
  | "return_data_invalid"
  | "program_reentrancy"
  | "missing_recipient_token_account"
  | "fee_payer_lamports_changed"
  | "amount_insufficient";

export type VerifyAgenticProgramPaymentResult =
  | { ok: true; recipientTokenAccount: string; receivedAmount: bigint }
  | { ok: false; reason: AgenticVerificationFailureReason; message?: string };

/**
 * Verify a program-based (agentic) payment by simulating the fully signed
 * transaction and enforcing invariants. Parity concept with EIP-1271 smart
 * wallet verification on EVM, for payers that are Solana programs rather
 * than keypairs.
 *
 * Invariants enforced:
 * 1. The payer program account is executable.
 * 2. Optional timelock bounds hold against the clock.
 * 3. The simulation succeeds with signature verification on.
 * 4. The payer program set return data equal to `x402_svm_ok_v1`.
 * 5. The payer program was invoked exactly once.
 * 6. The fee payer's lamports are conserved.
 * 7. The recipient token account balance increased by at least `minAmount`.
 *
 * @param params - Verification inputs.
 * @returns The verification result with a machine-readable failure reason.
 */
export async function verifyAgenticProgramPayment(
  params: VerifyAgenticProgramPaymentParams,
): Promise<VerifyAgenticProgramPaymentResult> {
  const { rpc, feePayer, payerProgram } = params;

  if (!params.recipientTokenAccount && !(params.mint && params.payTo)) {
    throw new TypeError("Provide recipientTokenAccount, or both mint and payTo.");
  }

  // Invariant 1: payer must be an executable program account.
  const programInfo = await rpc.getAccountInfo(payerProgram, { encoding: "base64" }).send();
  if (!programInfo.value || programInfo.value.executable !== true) {
    return { ok: false, reason: "payer_not_executable_program" };
  }

  // Invariant 2: optional timelock.
  const bounds = parseTimelock(params.timelock as Record<string, unknown> | undefined);
  if (bounds.validAfter !== undefined || bounds.validBefore !== undefined) {
    const now = params.nowSeconds ?? BigInt(Math.floor(Date.now() / 1000));
    const timelock = checkTimelock(bounds, now);
    if (!timelock.ok) return { ok: false, reason: timelock.reason };
  }

  // Resolve the recipient token account.
  let recipientTokenAccount = params.recipientTokenAccount;
  if (!recipientTokenAccount) {
    const mint = params.mint as string;
    const payTo = params.payTo as string;
    const mintInfo = await rpc.getAccountInfo(mint, { encoding: "base64" }).send();
    const tokenProgramOwner = mintInfo.value?.owner?.toString();
    if (
      tokenProgramOwner !== TOKEN_PROGRAM_ADDRESS &&
      tokenProgramOwner !== TOKEN_2022_PROGRAM_ADDRESS
    ) {
      return { ok: false, reason: "mint_unknown_token_program" };
    }
    recipientTokenAccount = await findAssociatedTokenAccount({
      owner: payTo,
      mint,
      tokenProgram: tokenProgramOwner,
    });
  }

  // Pre-simulation balances.
  const preRecipient = await rpc
    .getAccountInfo(recipientTokenAccount, { encoding: "jsonParsed" })
    .send();
  const preRecipientAmount = preRecipient.value
    ? (parseTokenAmountFromParsedAccount(preRecipient.value.data) ?? 0n)
    : 0n;

  const preFeePayer = await rpc.getAccountInfo(feePayer, { encoding: "base64" }).send();
  const preFeePayerLamports = parseBigIntLike(preFeePayer.value?.lamports) ?? 0n;

  // Invariant 3: simulation succeeds with signature verification on.
  const simulation = await rpc
    .simulateTransaction(params.signedTransaction, {
      sigVerify: true,
      replaceRecentBlockhash: false,
      commitment: "confirmed",
      encoding: "base64",
      accounts: {
        encoding: "jsonParsed",
        addresses: [recipientTokenAccount, feePayer],
      },
    })
    .send();

  if (simulation.value.err) {
    const message = JSON.stringify(simulation.value.err, (_, v) =>
      typeof v === "bigint" ? v.toString() : v,
    );
    return { ok: false, reason: "simulation_failed", message };
  }

  // Invariant 4: return data magic from the payer program.
  const magic = checkReturnDataMagic(simulation.value.returnData, payerProgram);
  if (!magic.ok) {
    return { ok: false, reason: "return_data_invalid", message: magic.reason };
  }

  // Invariant 5: the payer program runs exactly once.
  const invocations = countProgramInvocations(simulation.value.logs, payerProgram);
  if (invocations !== 1) {
    return { ok: false, reason: "program_reentrancy" };
  }

  // Invariants 6 and 7: post-simulation account states.
  const [postRecipientAccount, postFeePayerAccount] = simulation.value.accounts ?? [];
  const postRecipientAmount = postRecipientAccount
    ? parseTokenAmountFromParsedAccount(postRecipientAccount.data)
    : null;
  if (postRecipientAmount === null) {
    return { ok: false, reason: "missing_recipient_token_account" };
  }

  if (postFeePayerAccount) {
    // An unparseable post-state is treated as conserved, matching the
    // behavior of the original implementation.
    const postLamports = parseBigIntLike(postFeePayerAccount.lamports) ?? preFeePayerLamports;
    if (postLamports !== preFeePayerLamports) {
      return { ok: false, reason: "fee_payer_lamports_changed" };
    }
  }

  const receivedAmount = postRecipientAmount - preRecipientAmount;
  if (receivedAmount < params.minAmount) {
    return { ok: false, reason: "amount_insufficient" };
  }

  return { ok: true, recipientTokenAccount, receivedAmount };
}
