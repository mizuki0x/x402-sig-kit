import { describe, expect, it, vi } from "vitest";
import { hashTypedData, isAddressEqual, recoverAddress, serializeErc6492Signature } from "viem";
import type { Address, Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  EIP1271_MAGIC_VALUE,
  isContractWallet,
  isValidTypedDataSignature,
  verifyTypedDataSignature,
} from "../src/evm/index.js";
import type { EvmCodeReader } from "../src/evm/index.js";

// Well-known public test keys (hardhat/anvil accounts 0 and 1). Test use only.
const OWNER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const STRANGER_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";

const owner = privateKeyToAccount(OWNER_KEY);
const stranger = privateKeyToAccount(STRANGER_KEY);

const WALLET = "0x1111111111111111111111111111111111111111" as Address;
const FACTORY = "0x2222222222222222222222222222222222222222" as Address;
const FACTORY_DATA = "0x1234" as Hex;

const typedData = {
  domain: {
    name: "USDC",
    version: "2",
    chainId: 84532,
    verifyingContract: "0x036cbd53842c5426634e7929541ec2318f3dcf7e" as Address,
  },
  types: {
    TransferWithAuthorization: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "validAfter", type: "uint256" },
      { name: "validBefore", type: "uint256" },
      { name: "nonce", type: "bytes32" },
    ],
  },
  primaryType: "TransferWithAuthorization",
  message: {
    from: WALLET,
    to: "0x9876543210987654321098765432109876543210" as Address,
    value: 1000000n,
    validAfter: 0n,
    validBefore: 99999999999n,
    nonce: `0x${"11".repeat(32)}` as Hex,
  },
} as const;

/** Reader for an address with no code on chain. */
function emptyReader(): EvmCodeReader {
  return {
    getCode: vi.fn(async () => "0x" as Hex),
    readContract: vi.fn(async () => {
      throw new Error("no contract at address");
    }),
  };
}

/**
 * Reader that models a deployed ERC-1271 wallet owned by `ownerAddress`.
 * isValidSignature recovers the digest signer for real, so the test fails
 * if the library passes a wrong digest or a wrapped signature.
 */
function walletReader(walletAddress: Address, ownerAddress: Address) {
  const readContract = vi.fn(
    async (params: {
      address: Address;
      functionName: "isValidSignature";
      args: readonly [Hex, Hex];
    }) => {
      expect(params.functionName).toBe("isValidSignature");
      if (!isAddressEqual(params.address, walletAddress)) throw new Error("unknown contract");
      const [hash, signature] = params.args;
      try {
        const recovered = await recoverAddress({ hash, signature });
        return isAddressEqual(recovered, ownerAddress) ? EIP1271_MAGIC_VALUE : "0xffffffff";
      } catch {
        return "0xffffffff";
      }
    },
  );
  const getCode = vi.fn(async ({ address }: { address: Address }) =>
    isAddressEqual(address, walletAddress) ? ("0x6080604052" as Hex) : ("0x" as Hex),
  );
  return { getCode, readContract };
}

describe("verifyTypedDataSignature", () => {
  it("accepts a plain EOA signature via ECDSA recovery without touching the chain", async () => {
    const signature = await owner.signTypedData(typedData);
    const reader = emptyReader();

    const verdict = await verifyTypedDataSignature({
      reader,
      signer: owner.address,
      signature,
      typedData,
    });

    expect(verdict).toEqual({ status: "valid", method: "ecdsa" });
    expect(reader.getCode).not.toHaveBeenCalled();
    expect(reader.readContract).not.toHaveBeenCalled();
  });

  it("rejects an EOA signature from the wrong signer", async () => {
    const signature = await stranger.signTypedData(typedData);

    const verdict = await verifyTypedDataSignature({
      reader: emptyReader(),
      signer: owner.address,
      signature,
      typedData,
    });

    expect(verdict).toEqual({ status: "invalid", reason: "signature_mismatch" });
  });

  it("accepts a deployed smart wallet signature via ERC-1271 with the correct digest", async () => {
    const signature = await owner.signTypedData(typedData);
    const reader = walletReader(WALLET, owner.address);

    const verdict = await verifyTypedDataSignature({
      reader,
      signer: WALLET,
      signature,
      typedData,
    });

    expect(verdict).toEqual({ status: "valid", method: "erc1271" });
    const call = reader.readContract.mock.calls[0]?.[0];
    expect(call?.args[0]).toBe(hashTypedData(typedData));
    expect(call?.args[1]).toBe(signature);
  });

  it("treats the ERC-1271 magic value as case-insensitive", async () => {
    const signature = await owner.signTypedData(typedData);
    const reader: EvmCodeReader = {
      getCode: async () => "0x6080" as Hex,
      readContract: async () => "0x1626BA7E",
    };

    const verdict = await verifyTypedDataSignature({
      reader,
      signer: WALLET,
      signature,
      typedData,
    });

    expect(verdict).toEqual({ status: "valid", method: "erc1271" });
  });

  it("rejects when the wallet's owner did not sign", async () => {
    const signature = await stranger.signTypedData(typedData);
    const reader = walletReader(WALLET, owner.address);

    const verdict = await verifyTypedDataSignature({
      reader,
      signer: WALLET,
      signature,
      typedData,
    });

    expect(verdict).toEqual({ status: "invalid", reason: "erc1271_rejected" });
  });

  it("reports a failed isValidSignature call distinctly", async () => {
    const signature = await owner.signTypedData(typedData);
    const reader: EvmCodeReader = {
      getCode: async () => "0x6080" as Hex,
      readContract: async () => {
        throw new Error("execution reverted");
      },
    };

    const verdict = await verifyTypedDataSignature({
      reader,
      signer: WALLET,
      signature,
      typedData,
    });

    expect(verdict).toEqual({ status: "invalid", reason: "erc1271_call_failed" });
  });

  it("unwraps an ERC-6492 signature before the ERC-1271 call when the wallet is deployed", async () => {
    const innerSignature = await owner.signTypedData(typedData);
    const wrapped = serializeErc6492Signature({
      address: FACTORY,
      data: FACTORY_DATA,
      signature: innerSignature,
    });
    const reader = walletReader(WALLET, owner.address);

    const verdict = await verifyTypedDataSignature({
      reader,
      signer: WALLET,
      signature: wrapped,
      typedData,
    });

    expect(verdict).toEqual({ status: "valid", method: "erc1271" });
    const call = reader.readContract.mock.calls[0]?.[0];
    expect(call?.args[1]).toBe(innerSignature);
  });

  it("returns indeterminate with deployment data for an undeployed ERC-6492 wallet", async () => {
    const innerSignature = await owner.signTypedData(typedData);
    const wrapped = serializeErc6492Signature({
      address: FACTORY,
      data: FACTORY_DATA,
      signature: innerSignature,
    });

    const verdict = await verifyTypedDataSignature({
      reader: emptyReader(),
      signer: WALLET,
      signature: wrapped,
      typedData,
    });

    expect(verdict).toEqual({
      status: "indeterminate",
      reason: "undeployed_erc6492_wallet",
      deployment: { factory: FACTORY, factoryData: FACTORY_DATA },
    });
  });

  it("rejects a long non-ERC-6492 signature for an address without code", async () => {
    const signature = `0x${"ab".repeat(100)}` as Hex;

    const verdict = await verifyTypedDataSignature({
      reader: emptyReader(),
      signer: WALLET,
      signature,
      typedData,
    });

    expect(verdict).toEqual({ status: "invalid", reason: "undeployed_smart_wallet" });
  });

  it("treats a getCode failure as no code", async () => {
    const signature = await stranger.signTypedData(typedData);
    const reader: EvmCodeReader = {
      getCode: async () => {
        throw new Error("rpc down");
      },
      readContract: async () => EIP1271_MAGIC_VALUE,
    };

    const verdict = await verifyTypedDataSignature({
      reader,
      signer: owner.address,
      signature,
      typedData,
    });

    expect(verdict).toEqual({ status: "invalid", reason: "signature_mismatch" });
  });
});

describe("isValidTypedDataSignature", () => {
  it("rejects undeployed ERC-6492 wallets by default and accepts them on opt-in", async () => {
    const innerSignature = await owner.signTypedData(typedData);
    const wrapped = serializeErc6492Signature({
      address: FACTORY,
      data: FACTORY_DATA,
      signature: innerSignature,
    });
    const params = {
      reader: emptyReader(),
      signer: WALLET,
      signature: wrapped,
      typedData,
    };

    await expect(isValidTypedDataSignature(params)).resolves.toBe(false);
    await expect(
      isValidTypedDataSignature(params, { acceptUndeployedErc6492: true }),
    ).resolves.toBe(true);
  });

  it("returns true for a valid EOA signature", async () => {
    const signature = await owner.signTypedData(typedData);
    await expect(
      isValidTypedDataSignature({
        reader: emptyReader(),
        signer: owner.address,
        signature,
        typedData,
      }),
    ).resolves.toBe(true);
  });
});

describe("isContractWallet", () => {
  it("is true for an address with code", async () => {
    await expect(
      isContractWallet({ getCode: async () => "0x6080" as Hex }, WALLET),
    ).resolves.toBe(true);
  });

  it("is false for empty code, undefined code, and reader failures", async () => {
    await expect(isContractWallet({ getCode: async () => "0x" as Hex }, WALLET)).resolves.toBe(
      false,
    );
    await expect(isContractWallet({ getCode: async () => undefined }, WALLET)).resolves.toBe(
      false,
    );
    await expect(
      isContractWallet(
        {
          getCode: async () => {
            throw new Error("rpc down");
          },
        },
        WALLET,
      ),
    ).resolves.toBe(false);
  });
});
