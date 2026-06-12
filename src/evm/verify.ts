import {
  hashTypedData,
  isAddressEqual,
  parseErc6492Signature,
  recoverTypedDataAddress,
} from "viem";
import type { Address, Hex, TypedData, TypedDataDefinition } from "viem";
import { EIP1271_MAGIC_VALUE, eip1271Abi } from "./constants.js";
import type { EvmCodeReader, SignatureVerdict } from "./types.js";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;

export interface VerifyTypedDataSignatureParams<
  typedData extends TypedData | Record<string, unknown> = TypedData,
  primaryType extends keyof typedData | "EIP712Domain" = keyof typedData,
> {
  /** Minimal chain reader. See {@link EvmCodeReader}. */
  reader: EvmCodeReader;
  /** Address expected to have produced the signature. */
  signer: Address;
  /** Signature bytes. May be ERC-6492 wrapped. */
  signature: Hex;
  /** The EIP-712 payload that was signed. */
  typedData: TypedDataDefinition<typedData, primaryType>;
}

/**
 * Verify an EIP-712 signature against an address that may be an EOA, a
 * deployed ERC-1271 contract wallet, or an undeployed ERC-4337 wallet with an
 * ERC-6492 wrapped signature.
 *
 * Verification ladder:
 * 1. Pure ECDSA recovery. No RPC round trip. Accepts standard EOA signatures.
 * 2. If recovery fails and the signer has code on chain, call
 *    `isValidSignature(bytes32,bytes)` with the EIP-712 digest and the
 *    unwrapped signature, and require the EIP-1271 magic value.
 * 3. If the signer has no code and the signature carries ERC-6492 deployment
 *    data, return `indeterminate` with that data. Validity can only be
 *    decided by deploying the wallet (or simulating deployment) on chain.
 * 4. Anything else is invalid.
 *
 * @param params - Verification inputs.
 * @returns A {@link SignatureVerdict}.
 */
export async function verifyTypedDataSignature<
  const typedData extends TypedData | Record<string, unknown>,
  primaryType extends keyof typedData | "EIP712Domain",
>(params: VerifyTypedDataSignatureParams<typedData, primaryType>): Promise<SignatureVerdict> {
  const { reader, signer, signature } = params;
  const typedData = params.typedData as TypedDataDefinition;

  const erc6492 = parseErc6492Signature(signature);
  const innerSignature = erc6492.signature;
  const innerLength = innerSignature.startsWith("0x")
    ? innerSignature.length - 2
    : innerSignature.length;

  // Step 1: plain ECDSA recovery.
  try {
    const recovered = await recoverTypedDataAddress({ ...typedData, signature });
    if (isAddressEqual(recovered, signer)) {
      return { status: "valid", method: "ecdsa" };
    }
  } catch {
    // Not a recoverable ECDSA signature for this payload.
    // Fall through to the smart wallet checks.
  }

  // Step 2: deployed contract wallet via ERC-1271.
  let bytecode: Hex | undefined;
  try {
    bytecode = await reader.getCode({ address: signer });
  } catch {
    bytecode = undefined;
  }

  if (bytecode && bytecode !== "0x") {
    const digest = hashTypedData(typedData);
    let magicValue: unknown;
    try {
      magicValue = await reader.readContract({
        address: signer,
        abi: eip1271Abi,
        functionName: "isValidSignature",
        args: [digest, innerSignature],
      });
    } catch {
      return { status: "invalid", reason: "erc1271_call_failed" };
    }
    if (typeof magicValue === "string" && magicValue.toLowerCase() === EIP1271_MAGIC_VALUE) {
      return { status: "valid", method: "erc1271" };
    }
    return { status: "invalid", reason: "erc1271_rejected" };
  }

  // Step 3: undeployed wallet with ERC-6492 deployment data.
  if (erc6492.address && erc6492.data && !isAddressEqual(erc6492.address, ZERO_ADDRESS)) {
    return {
      status: "indeterminate",
      reason: "undeployed_erc6492_wallet",
      deployment: { factory: erc6492.address, factoryData: erc6492.data },
    };
  }

  // Step 4: a long non-ERC-6492 signature for an address without code is an
  // undeployed smart wallet. It cannot validate on chain in this state.
  if (innerLength > 130) {
    return { status: "invalid", reason: "undeployed_smart_wallet" };
  }

  return { status: "invalid", reason: "signature_mismatch" };
}

export interface IsValidTypedDataSignatureOptions {
  /**
   * Treat `indeterminate` verdicts (undeployed ERC-6492 wallets) as valid.
   * Only set this when the caller can deploy the wallet at settlement time.
   * Defaults to false.
   */
  acceptUndeployedErc6492?: boolean;
}

/**
 * Boolean convenience wrapper around {@link verifyTypedDataSignature}.
 *
 * @param params - Verification inputs.
 * @param options - Policy for indeterminate verdicts.
 * @returns True when the verdict is `valid`, or `indeterminate` with
 * `acceptUndeployedErc6492` enabled.
 */
export async function isValidTypedDataSignature<
  const typedData extends TypedData | Record<string, unknown>,
  primaryType extends keyof typedData | "EIP712Domain",
>(
  params: VerifyTypedDataSignatureParams<typedData, primaryType>,
  options: IsValidTypedDataSignatureOptions = {},
): Promise<boolean> {
  const verdict = await verifyTypedDataSignature(params);
  if (verdict.status === "valid") return true;
  if (verdict.status === "indeterminate") return options.acceptUndeployedErc6492 ?? false;
  return false;
}

/**
 * Check whether an address currently has code on chain.
 *
 * Useful at settlement time: EIP-3009 `transferWithAuthorization` takes a
 * `(v, r, s)` overload for EOAs and a `bytes` overload for contract wallets.
 * Selecting the overload by code presence is robust. Selecting it by
 * signature length is not, because contract wallets can produce 65-byte
 * signatures.
 *
 * @param reader - Chain reader exposing `getCode`.
 * @param address - Address to inspect.
 * @returns True when the address has non-empty bytecode.
 */
export async function isContractWallet(
  reader: Pick<EvmCodeReader, "getCode">,
  address: Address,
): Promise<boolean> {
  try {
    const code = await reader.getCode({ address });
    return Boolean(code && code !== "0x");
  } catch {
    return false;
  }
}
