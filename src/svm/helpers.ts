import { getBase64Encoder } from "@solana/kit";
import type { ReadonlyUint8Array } from "@solana/kit";
import { SOLANA_MAGIC_OK } from "./constants.js";

/**
 * Parse a bigint-like value from mixed runtime inputs (RPC responses, config).
 *
 * @param value - Value to parse.
 * @returns Parsed bigint, or null when not parseable.
 */
export function parseBigIntLike(value: unknown): bigint | null {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isFinite(value)) return BigInt(Math.trunc(value));
  if (typeof value === "string" && value.trim() !== "" && /^-?\d+$/.test(value.trim())) {
    return BigInt(value.trim());
  }
  return null;
}

/**
 * Extract a token amount (base units) from a jsonParsed token account payload.
 *
 * @param data - The `value.data` field of a jsonParsed account response.
 * @returns Token amount as bigint, or null when unavailable.
 */
export function parseTokenAmountFromParsedAccount(data: unknown): bigint | null {
  if (!data || typeof data !== "object") return null;

  const parsed = (data as { parsed?: unknown }).parsed;
  if (!parsed || typeof parsed !== "object") return null;

  const info = (parsed as { info?: unknown }).info;
  if (!info || typeof info !== "object") return null;

  const tokenAmount = (info as { tokenAmount?: unknown }).tokenAmount;
  if (!tokenAmount || typeof tokenAmount !== "object") return null;

  return parseBigIntLike((tokenAmount as { amount?: unknown }).amount);
}

/**
 * Count how many times a program was invoked in simulation logs.
 *
 * @param logs - Simulation log messages.
 * @param programId - Program id to count.
 * @returns Number of invocations found.
 */
export function countProgramInvocations(
  logs: readonly string[] | null | undefined,
  programId: string,
): number {
  if (!logs) return 0;
  const needle = `Program ${programId} invoke`;
  return logs.reduce((count, line) => (line.includes(needle) ? count + 1 : count), 0);
}

/** Return data shape from `simulateTransaction`. */
export interface SimulationReturnData {
  programId: string;
  data: readonly [string, string];
}

export type ReturnDataCheck = { ok: true } | { ok: false; reason: string };

/**
 * Validate that simulation return data was set by the expected program and
 * matches the expected magic value byte for byte.
 *
 * @param returnData - The `returnData` field of a simulation response.
 * @param expectedProgramId - Program required to have set the return data.
 * @param expectedValue - Expected magic string. Defaults to {@link SOLANA_MAGIC_OK}.
 * @returns The check result with a machine-readable failure reason.
 */
export function checkReturnDataMagic(
  returnData: SimulationReturnData | null | undefined,
  expectedProgramId: string,
  expectedValue: string = SOLANA_MAGIC_OK,
): ReturnDataCheck {
  if (!returnData) return { ok: false, reason: "missing_return_data" };
  if (returnData.programId !== expectedProgramId) {
    return { ok: false, reason: "return_data_program_mismatch" };
  }

  const [data, encoding] = returnData.data;
  if (encoding !== "base64") return { ok: false, reason: "return_data_encoding_not_base64" };

  let decoded: ReadonlyUint8Array;
  try {
    decoded = getBase64Encoder().encode(data);
  } catch {
    return { ok: false, reason: "return_data_undecodable" };
  }

  const expected = new TextEncoder().encode(expectedValue);
  if (decoded.length !== expected.length) {
    return { ok: false, reason: "return_data_length_mismatch" };
  }
  for (let i = 0; i < expected.length; i += 1) {
    if (decoded[i] !== expected[i]) return { ok: false, reason: "return_data_value_mismatch" };
  }
  return { ok: true };
}

/** Unix-second bounds for an optional verification timelock. */
export interface TimelockBounds {
  validAfter?: bigint;
  validBefore?: bigint;
}

/**
 * Parse optional timelock bounds from an x402 `PaymentRequirements.extra`
 * style record. Non-numeric values are ignored.
 *
 * @param extra - Record possibly carrying `validAfter` and `validBefore`.
 * @returns Parsed bounds.
 */
export function parseTimelock(extra: Record<string, unknown> | undefined): TimelockBounds {
  if (!extra) return {};
  const validAfter = parseBigIntLike(extra["validAfter"]);
  const validBefore = parseBigIntLike(extra["validBefore"]);
  return {
    ...(validAfter !== null ? { validAfter } : {}),
    ...(validBefore !== null ? { validBefore } : {}),
  };
}

export type TimelockCheck =
  | { ok: true }
  | { ok: false; reason: "timelock_not_started" | "timelock_expired" };

/**
 * Check timelock bounds against a clock value.
 *
 * Rejects when `now < validAfter` or `now >= validBefore`.
 *
 * @param bounds - Parsed timelock bounds.
 * @param nowSeconds - Current unix time in seconds.
 * @returns The check result.
 */
export function checkTimelock(bounds: TimelockBounds, nowSeconds: bigint): TimelockCheck {
  if (bounds.validAfter !== undefined && nowSeconds < bounds.validAfter) {
    return { ok: false, reason: "timelock_not_started" };
  }
  if (bounds.validBefore !== undefined && nowSeconds >= bounds.validBefore) {
    return { ok: false, reason: "timelock_expired" };
  }
  return { ok: true };
}
