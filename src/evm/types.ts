import type { Address, Hex } from "viem";
import type { eip1271Abi } from "./constants.js";

/**
 * Minimal chain reader needed for smart wallet signature verification.
 *
 * A viem `PublicClient` can be adapted in one line:
 *
 * ```ts
 * const reader: EvmCodeReader = {
 *   getCode: args => client.getCode(args),
 *   readContract: args => client.readContract(args),
 * };
 * ```
 */
export interface EvmCodeReader {
  getCode(args: { address: Address }): Promise<Hex | undefined>;
  readContract(args: {
    address: Address;
    abi: typeof eip1271Abi;
    functionName: "isValidSignature";
    args: readonly [Hex, Hex];
  }): Promise<unknown>;
}

/**
 * ERC-6492 deployment data carried by a wrapped signature.
 */
export interface Erc6492Deployment {
  factory: Address;
  factoryData: Hex;
}

/**
 * Three-state verification verdict.
 *
 * - `valid`: the signature was verified, either by ECDSA recovery or by an
 *   on-chain ERC-1271 `isValidSignature` call.
 * - `indeterminate`: the signer has no code on chain and the signature carries
 *   ERC-6492 deployment data. It cannot be verified before the wallet is
 *   deployed. Callers that can sponsor deployment at settlement may choose to
 *   accept it.
 * - `invalid`: the signature failed every applicable check.
 */
export type SignatureVerdict =
  | { status: "valid"; method: "ecdsa" | "erc1271" }
  | {
      status: "indeterminate";
      reason: "undeployed_erc6492_wallet";
      deployment: Erc6492Deployment;
    }
  | {
      status: "invalid";
      reason:
        | "signature_mismatch"
        | "erc1271_rejected"
        | "erc1271_call_failed"
        | "undeployed_smart_wallet";
    };
