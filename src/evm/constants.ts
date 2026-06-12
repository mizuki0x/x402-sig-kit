/**
 * EIP-1271 magic value returned by `isValidSignature(bytes32,bytes)` on success.
 */
export const EIP1271_MAGIC_VALUE = "0x1626ba7e" as const;

/**
 * Minimal ABI for the EIP-1271 `isValidSignature` view function.
 */
export const eip1271Abi = [
  {
    type: "function",
    name: "isValidSignature",
    inputs: [
      { name: "hash", type: "bytes32" },
      { name: "signature", type: "bytes" },
    ],
    outputs: [{ name: "magicValue", type: "bytes4" }],
    stateMutability: "view",
  },
] as const;
