import { beforeAll, describe, expect, it, vi } from "vitest";
import { generateKeyPairSigner } from "@solana/kit";
import { TOKEN_PROGRAM_ADDRESS as REF_TOKEN_PROGRAM } from "@solana-program/token";
import { findAssociatedTokenPda } from "@solana-program/token-2022";
import {
  SOLANA_MAGIC_OK,
  TOKEN_PROGRAM_ADDRESS,
  verifyAgenticProgramPayment,
} from "../src/svm/index.js";
import type { SvmAccountInfoResponse, SvmRpcLike } from "../src/svm/index.js";

const PAYER_PROGRAM = "BPFLoader1111111111111111111111111111111111";
const SIGNED_TX = Buffer.from("placeholder-signed-transaction").toString("base64");
const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

let feePayer: string;
let payTo: string;
let mint: string;
let expectedAta: string;

beforeAll(async () => {
  feePayer = (await generateKeyPairSigner()).address;
  payTo = (await generateKeyPairSigner()).address;
  mint = (await generateKeyPairSigner()).address;
  const [ata] = await findAssociatedTokenPda({
    owner: payTo as never,
    mint: mint as never,
    tokenProgram: REF_TOKEN_PROGRAM,
  });
  expectedAta = ata.toString();
});

interface MockRpcOptions {
  payerExecutable?: boolean;
  mintOwner?: string;
  returnDataProgramId?: string;
  returnDataValue?: string | null;
  invocationCount?: number;
  simulationErr?: unknown;
  preFeePayerLamports?: number;
  postFeePayerLamports?: number;
  preRecipientAmount?: string;
  postRecipientAmount?: string;
}

function makeRpc(options: MockRpcOptions = {}) {
  const {
    payerExecutable = true,
    mintOwner = TOKEN_PROGRAM_ADDRESS,
    returnDataProgramId = PAYER_PROGRAM,
    returnDataValue = SOLANA_MAGIC_OK,
    invocationCount = 1,
    simulationErr = null,
    preFeePayerLamports = 1_000_000,
    postFeePayerLamports = preFeePayerLamports,
    preRecipientAmount = "0",
    postRecipientAmount = "1000",
  } = options;

  const logs = [
    ...Array.from(
      { length: invocationCount },
      (_, i) => `Program ${PAYER_PROGRAM} invoke [${i + 1}]`,
    ),
    `Program ${PAYER_PROGRAM} success`,
  ];

  const returnData =
    returnDataValue === null
      ? null
      : { programId: returnDataProgramId, data: [b64(returnDataValue), "base64"] as const };

  const getAccountInfo = vi.fn(
    (address: string, config?: { encoding?: string; commitment?: string }) => {
      let value: SvmAccountInfoResponse["value"] = null;
      if (address === PAYER_PROGRAM) {
        value = {
          executable: payerExecutable,
          owner: "NativeLoader1111111111111111111111111111111",
        };
      } else if (address === mint) {
        value = { owner: mintOwner };
      } else if (address === feePayer) {
        value = { lamports: preFeePayerLamports };
      } else if (config?.encoding === "jsonParsed") {
        value = { data: { parsed: { info: { tokenAmount: { amount: preRecipientAmount } } } } };
      }
      return { send: async () => ({ value }) };
    },
  );

  const simulateTransaction = vi.fn(
    (
      _tx: string,
      config?: {
        sigVerify?: boolean;
        replaceRecentBlockhash?: boolean;
        commitment?: string;
        encoding?: string;
        accounts?: { encoding?: string; addresses: readonly string[] };
      },
    ) => {
      const addresses = config?.accounts?.addresses ?? [];
      const accounts = addresses.map(address =>
        address === feePayer
          ? { lamports: postFeePayerLamports }
          : { data: { parsed: { info: { tokenAmount: { amount: postRecipientAmount } } } } },
      );
      return {
        send: async () => ({
          value: { err: simulationErr, logs, returnData, accounts },
        }),
      };
    },
  );

  return { getAccountInfo, simulateTransaction };
}

function baseParams(rpc: SvmRpcLike) {
  return {
    rpc,
    signedTransaction: SIGNED_TX,
    feePayer,
    payerProgram: PAYER_PROGRAM,
    mint,
    payTo,
    minAmount: 1000n,
  };
}

describe("verifyAgenticProgramPayment", () => {
  it("accepts a payment that satisfies every invariant", async () => {
    const rpc = makeRpc();
    const result = await verifyAgenticProgramPayment(baseParams(rpc));

    expect(result).toEqual({
      ok: true,
      recipientTokenAccount: expectedAta,
      receivedAmount: 1000n,
    });

    expect(rpc.simulateTransaction).toHaveBeenCalledTimes(1);
    const [tx, config] = rpc.simulateTransaction.mock.calls[0]!;
    expect(tx).toBe(SIGNED_TX);
    expect(config?.sigVerify).toBe(true);
    expect(config?.replaceRecentBlockhash).toBe(false);
    expect(config?.accounts?.addresses).toEqual([expectedAta, feePayer]);
  });

  it("skips the mint lookup when recipientTokenAccount is given", async () => {
    const rpc = makeRpc();
    const result = await verifyAgenticProgramPayment({
      ...baseParams(rpc),
      mint: undefined,
      payTo: undefined,
      recipientTokenAccount: expectedAta,
    });

    expect(result.ok).toBe(true);
    const queried = rpc.getAccountInfo.mock.calls.map(call => call[0]);
    expect(queried).not.toContain(mint);
  });

  it("throws when neither recipientTokenAccount nor mint and payTo are given", async () => {
    const rpc = makeRpc();
    await expect(
      verifyAgenticProgramPayment({ ...baseParams(rpc), mint: undefined }),
    ).rejects.toThrow(TypeError);
  });

  it("rejects a payer that is not an executable program", async () => {
    const rpc = makeRpc({ payerExecutable: false });
    const result = await verifyAgenticProgramPayment(baseParams(rpc));

    expect(result).toEqual({ ok: false, reason: "payer_not_executable_program" });
    expect(rpc.simulateTransaction).not.toHaveBeenCalled();
  });

  it("rejects a mint owned by an unknown program", async () => {
    const rpc = makeRpc({ mintOwner: "Stake11111111111111111111111111111111111111" });
    const result = await verifyAgenticProgramPayment(baseParams(rpc));

    expect(result).toEqual({ ok: false, reason: "mint_unknown_token_program" });
  });

  it("rejects when the simulation fails", async () => {
    const rpc = makeRpc({ simulationErr: { InstructionError: [0, "Custom"] } });
    const result = await verifyAgenticProgramPayment(baseParams(rpc));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("simulation_failed");
      expect(result.message).toContain("InstructionError");
    }
  });

  it("rejects missing return data", async () => {
    const rpc = makeRpc({ returnDataValue: null });
    const result = await verifyAgenticProgramPayment(baseParams(rpc));

    expect(result).toEqual({
      ok: false,
      reason: "return_data_invalid",
      message: "missing_return_data",
    });
  });

  it("rejects the wrong magic value", async () => {
    const rpc = makeRpc({ returnDataValue: "x402_svm_ok_v2" });
    const result = await verifyAgenticProgramPayment(baseParams(rpc));

    expect(result).toEqual({
      ok: false,
      reason: "return_data_invalid",
      message: "return_data_value_mismatch",
    });
  });

  it("rejects return data set by another program", async () => {
    const rpc = makeRpc({ returnDataProgramId: "Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo" });
    const result = await verifyAgenticProgramPayment(baseParams(rpc));

    expect(result).toEqual({
      ok: false,
      reason: "return_data_invalid",
      message: "return_data_program_mismatch",
    });
  });

  it("rejects re-entrant payer program invocations", async () => {
    const rpc = makeRpc({ invocationCount: 2 });
    const result = await verifyAgenticProgramPayment(baseParams(rpc));

    expect(result).toEqual({ ok: false, reason: "program_reentrancy" });
  });

  it("rejects when the fee payer's lamports change", async () => {
    const rpc = makeRpc({ preFeePayerLamports: 1_000_000, postFeePayerLamports: 999_000 });
    const result = await verifyAgenticProgramPayment(baseParams(rpc));

    expect(result).toEqual({ ok: false, reason: "fee_payer_lamports_changed" });
  });

  it("rejects when the recipient receives less than minAmount", async () => {
    const rpc = makeRpc({ postRecipientAmount: "999" });
    const result = await verifyAgenticProgramPayment(baseParams(rpc));

    expect(result).toEqual({ ok: false, reason: "amount_insufficient" });
  });

  it("accepts overpayment", async () => {
    const rpc = makeRpc({ postRecipientAmount: "1500" });
    const result = await verifyAgenticProgramPayment(baseParams(rpc));

    expect(result).toEqual({
      ok: true,
      recipientTokenAccount: expectedAta,
      receivedAmount: 1500n,
    });
  });

  it("enforces the timelock lower bound", async () => {
    const rpc = makeRpc();
    const result = await verifyAgenticProgramPayment({
      ...baseParams(rpc),
      timelock: { validAfter: 1_000 },
      nowSeconds: 999n,
    });

    expect(result).toEqual({ ok: false, reason: "timelock_not_started" });
    expect(rpc.simulateTransaction).not.toHaveBeenCalled();
  });

  it("enforces the timelock upper bound", async () => {
    const rpc = makeRpc();
    const result = await verifyAgenticProgramPayment({
      ...baseParams(rpc),
      timelock: { validBefore: 2_000 },
      nowSeconds: 2_000n,
    });

    expect(result).toEqual({ ok: false, reason: "timelock_expired" });
  });

  it("passes an in-window timelock", async () => {
    const rpc = makeRpc();
    const result = await verifyAgenticProgramPayment({
      ...baseParams(rpc),
      timelock: { validAfter: 1_000, validBefore: 2_000 },
      nowSeconds: 1_500n,
    });

    expect(result.ok).toBe(true);
  });

  it("rejects when the recipient account is missing from the simulation", async () => {
    const rpc: SvmRpcLike = {
      getAccountInfo: makeRpc().getAccountInfo,
      simulateTransaction: () => ({
        send: async () => ({
          value: {
            err: null,
            logs: [`Program ${PAYER_PROGRAM} invoke [1]`],
            returnData: {
              programId: PAYER_PROGRAM,
              data: [b64(SOLANA_MAGIC_OK), "base64"] as const,
            },
            accounts: [null, { lamports: 1_000_000 }],
          },
        }),
      }),
    };
    const result = await verifyAgenticProgramPayment(baseParams(rpc));

    expect(result).toEqual({ ok: false, reason: "missing_recipient_token_account" });
  });
});
