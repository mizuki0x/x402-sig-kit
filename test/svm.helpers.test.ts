import { describe, expect, it } from "vitest";
import {
  AccountRole,
  appendTransactionMessageInstructions,
  compileTransaction,
  createTransactionMessage,
  generateKeyPairSigner,
  getBase64EncodedWireTransaction,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from "@solana/kit";
import type { Address, Blockhash, Instruction } from "@solana/kit";
import { TOKEN_PROGRAM_ADDRESS as REF_TOKEN_PROGRAM } from "@solana-program/token";
import {
  ASSOCIATED_TOKEN_PROGRAM_ADDRESS as REF_ATA_PROGRAM,
  TOKEN_2022_PROGRAM_ADDRESS as REF_TOKEN_2022_PROGRAM,
  findAssociatedTokenPda,
} from "@solana-program/token-2022";
import {
  ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
  MEMO_PROGRAM_ADDRESS,
  SOLANA_MAGIC_OK,
  TOKEN_2022_PROGRAM_ADDRESS,
  TOKEN_PROGRAM_ADDRESS,
  checkReturnDataMagic,
  checkTimelock,
  countProgramInvocations,
  feePayerAppearsInInstructionAccounts,
  findAssociatedTokenAccount,
  parseBigIntLike,
  parseTimelock,
  parseTokenAmountFromParsedAccount,
} from "../src/svm/index.js";

const PROGRAM = "BPFLoader1111111111111111111111111111111111";
const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

describe("program address constants", () => {
  it("match the reference @solana-program packages", () => {
    expect(TOKEN_PROGRAM_ADDRESS).toBe(REF_TOKEN_PROGRAM.toString());
    expect(TOKEN_2022_PROGRAM_ADDRESS).toBe(REF_TOKEN_2022_PROGRAM.toString());
    expect(ASSOCIATED_TOKEN_PROGRAM_ADDRESS).toBe(REF_ATA_PROGRAM.toString());
  });
});

describe("checkReturnDataMagic", () => {
  const okReturnData = { programId: PROGRAM, data: [b64(SOLANA_MAGIC_OK), "base64"] as const };

  it("accepts the magic value from the expected program", () => {
    expect(checkReturnDataMagic(okReturnData, PROGRAM)).toEqual({ ok: true });
  });

  it("rejects missing return data", () => {
    expect(checkReturnDataMagic(null, PROGRAM)).toEqual({
      ok: false,
      reason: "missing_return_data",
    });
    expect(checkReturnDataMagic(undefined, PROGRAM)).toEqual({
      ok: false,
      reason: "missing_return_data",
    });
  });

  it("rejects return data set by another program", () => {
    expect(checkReturnDataMagic(okReturnData, MEMO_PROGRAM_ADDRESS)).toEqual({
      ok: false,
      reason: "return_data_program_mismatch",
    });
  });

  it("rejects non-base64 encodings", () => {
    expect(
      checkReturnDataMagic({ programId: PROGRAM, data: [b64(SOLANA_MAGIC_OK), "base58"] }, PROGRAM),
    ).toEqual({ ok: false, reason: "return_data_encoding_not_base64" });
  });

  it("rejects values of the wrong length", () => {
    expect(checkReturnDataMagic({ programId: PROGRAM, data: [b64("x402"), "base64"] }, PROGRAM)).toEqual(
      { ok: false, reason: "return_data_length_mismatch" },
    );
  });

  it("rejects same-length values with different bytes", () => {
    expect(
      checkReturnDataMagic({ programId: PROGRAM, data: [b64("x402_svm_ok_v2"), "base64"] }, PROGRAM),
    ).toEqual({ ok: false, reason: "return_data_value_mismatch" });
  });
});

describe("countProgramInvocations", () => {
  it("counts only the requested program's invocations", () => {
    const logs = [
      `Program ${PROGRAM} invoke [1]`,
      "Program log: hello",
      `Program ${MEMO_PROGRAM_ADDRESS} invoke [1]`,
      `Program ${PROGRAM} invoke [2]`,
      `Program ${PROGRAM} success`,
    ];
    expect(countProgramInvocations(logs, PROGRAM)).toBe(2);
    expect(countProgramInvocations(logs, MEMO_PROGRAM_ADDRESS)).toBe(1);
    expect(countProgramInvocations(null, PROGRAM)).toBe(0);
    expect(countProgramInvocations([], PROGRAM)).toBe(0);
  });
});

describe("parseTokenAmountFromParsedAccount", () => {
  it("extracts the amount from a jsonParsed token account", () => {
    const data = { parsed: { info: { tokenAmount: { amount: "12345" } } } };
    expect(parseTokenAmountFromParsedAccount(data)).toBe(12345n);
  });

  it("returns null for malformed payloads", () => {
    expect(parseTokenAmountFromParsedAccount(null)).toBeNull();
    expect(parseTokenAmountFromParsedAccount({})).toBeNull();
    expect(parseTokenAmountFromParsedAccount({ parsed: {} })).toBeNull();
    expect(parseTokenAmountFromParsedAccount({ parsed: { info: {} } })).toBeNull();
    expect(
      parseTokenAmountFromParsedAccount({ parsed: { info: { tokenAmount: { amount: "x" } } } }),
    ).toBeNull();
  });
});

describe("parseBigIntLike", () => {
  it("parses bigints, finite numbers, and integer strings", () => {
    expect(parseBigIntLike(7n)).toBe(7n);
    expect(parseBigIntLike(7.9)).toBe(7n);
    expect(parseBigIntLike("42")).toBe(42n);
    expect(parseBigIntLike(" -42 ")).toBe(-42n);
  });

  it("returns null for everything else", () => {
    expect(parseBigIntLike("4.2")).toBeNull();
    expect(parseBigIntLike("")).toBeNull();
    expect(parseBigIntLike("abc")).toBeNull();
    expect(parseBigIntLike(Number.NaN)).toBeNull();
    expect(parseBigIntLike(undefined)).toBeNull();
    expect(parseBigIntLike({})).toBeNull();
  });
});

describe("timelock", () => {
  it("parses bounds from an extra-style record", () => {
    expect(parseTimelock({ validAfter: 100, validBefore: "200" })).toEqual({
      validAfter: 100n,
      validBefore: 200n,
    });
    expect(parseTimelock({ validAfter: "nope" })).toEqual({});
    expect(parseTimelock(undefined)).toEqual({});
  });

  it("enforces bounds", () => {
    expect(checkTimelock({ validAfter: 100n }, 99n)).toEqual({
      ok: false,
      reason: "timelock_not_started",
    });
    expect(checkTimelock({ validAfter: 100n }, 100n)).toEqual({ ok: true });
    expect(checkTimelock({ validBefore: 200n }, 200n)).toEqual({
      ok: false,
      reason: "timelock_expired",
    });
    expect(checkTimelock({ validBefore: 200n }, 199n)).toEqual({ ok: true });
    expect(checkTimelock({}, 0n)).toEqual({ ok: true });
  });
});

describe("findAssociatedTokenAccount", () => {
  it("matches the reference derivation for both token programs", async () => {
    const owner = await generateKeyPairSigner();
    const mint = await generateKeyPairSigner();

    for (const tokenProgram of [REF_TOKEN_PROGRAM, REF_TOKEN_2022_PROGRAM]) {
      const [expected] = await findAssociatedTokenPda({
        owner: owner.address,
        mint: mint.address,
        tokenProgram,
      });
      const actual = await findAssociatedTokenAccount({
        owner: owner.address,
        mint: mint.address,
        tokenProgram: tokenProgram.toString(),
      });
      expect(actual).toBe(expected.toString());
    }
  });
});

describe("feePayerAppearsInInstructionAccounts", () => {
  const lifetime = {
    blockhash: "11111111111111111111111111111111" as Blockhash,
    lastValidBlockHeight: 0n,
  };

  async function buildTransaction(feePayer: Address, instructions: Instruction[]) {
    const message = pipe(
      createTransactionMessage({ version: 0 }),
      m => setTransactionMessageFeePayer(feePayer, m),
      m => setTransactionMessageLifetimeUsingBlockhash(lifetime, m),
      m => appendTransactionMessageInstructions(instructions, m),
    );
    return getBase64EncodedWireTransaction(compileTransaction(message));
  }

  it("detects the fee payer in instruction accounts", async () => {
    const feePayer = await generateKeyPairSigner();
    const tx = await buildTransaction(feePayer.address, [
      {
        programAddress: MEMO_PROGRAM_ADDRESS as Address,
        accounts: [{ address: feePayer.address, role: AccountRole.WRITABLE }],
        data: new Uint8Array([1, 2, 3]),
      },
    ]);
    expect(feePayerAppearsInInstructionAccounts(tx, feePayer.address)).toBe(true);
  });

  it("passes when the fee payer only pays fees", async () => {
    const feePayer = await generateKeyPairSigner();
    const other = await generateKeyPairSigner();
    const tx = await buildTransaction(feePayer.address, [
      {
        programAddress: MEMO_PROGRAM_ADDRESS as Address,
        accounts: [{ address: other.address, role: AccountRole.READONLY }],
        data: new Uint8Array([1, 2, 3]),
      },
    ]);
    expect(feePayerAppearsInInstructionAccounts(tx, feePayer.address)).toBe(false);
  });
});
