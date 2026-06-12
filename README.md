# x402-sig-kit

Signature verification toolkit for x402-style payments. Verifies payers that are not plain EOA keypairs: ERC-1271 and ERC-6492 smart contract wallets on EVM chains, and program-based (agentic) payers on Solana.

Status: extracted from unmerged upstream work. The logic originated in two PRs to the x402 protocol repo ([x402-foundation/x402#1220](https://github.com/x402-foundation/x402/pull/1220) and [x402-foundation/x402#1225](https://github.com/x402-foundation/x402/pull/1225)) that were closed without review. This package repackages that work as a standalone library. It is not affiliated with or endorsed by the x402 project.

## Why

x402-style payment flows have a facilitator verify a signed payment authorization before settling it. Many verification stacks only do EOA ECDSA recovery. That silently rejects:

- Deployed smart contract wallets (Safe, Coinbase Smart Wallet, other ERC-4337 accounts), which validate signatures on chain via ERC-1271 `isValidSignature`.
- Counterfactual ERC-4337 wallets that sign with an ERC-6492 wrapper before deployment.
- Solana payers that are programs, not keypairs. A program cannot produce an ed25519 transaction signature for its own address at all.

This kit provides the missing verification paths as small, dependency-injected functions. It does not send transactions and it does not hold keys.

## Install

```bash
npm install github:mizuki0x/x402-sig-kit
```

Peer dependencies are optional per entry point: install `viem` for the EVM module, `@solana/kit` for the SVM module.

## EVM: smart wallet typed-data verification

`verifyTypedDataSignature` runs a three-step ladder:

1. Pure ECDSA recovery. No RPC call. Accepts standard EOA signatures.
2. If recovery fails and the signer has bytecode, it calls `isValidSignature(bytes32,bytes)` with the EIP-712 digest and the (ERC-6492 unwrapped) signature, and requires the `0x1626ba7e` magic value.
3. If the signer has no bytecode and the signature carries ERC-6492 deployment data, it returns `indeterminate` with the factory and calldata. Whether to accept is the caller's policy decision, since validity can only be proven by deploying the wallet.

```ts
import { createPublicClient, http } from "viem";
import { base } from "viem/chains";
import { verifyTypedDataSignature } from "x402-sig-kit/evm";

const client = createPublicClient({ chain: base, transport: http() });
const reader = {
  getCode: (args: { address: `0x${string}` }) => client.getCode(args),
  readContract: (args: Parameters<typeof client.readContract>[0]) => client.readContract(args),
};

const verdict = await verifyTypedDataSignature({
  reader,
  signer: payerAddress,
  signature: paymentSignature,
  typedData: {
    domain: { name: "USD Coin", version: "2", chainId: 8453, verifyingContract: usdc },
    types: transferWithAuthorizationTypes,
    primaryType: "TransferWithAuthorization",
    message: authorization,
  },
});

if (verdict.status === "valid") {
  // verdict.method is "ecdsa" or "erc1271"
}
```

A boolean wrapper mirrors the upstream facilitator behavior, where undeployed ERC-6492 wallets are only accepted when the facilitator can sponsor deployment at settlement:

```ts
import { isValidTypedDataSignature } from "x402-sig-kit/evm";

const ok = await isValidTypedDataSignature(params, { acceptUndeployedErc6492: false });
```

For settlement, `isContractWallet(reader, address)` tells you whether to use the `(v, r, s)` overload or the `bytes` overload of EIP-3009 `transferWithAuthorization`. Selecting the overload by bytecode presence is robust. Selecting it by signature length is not, because contract wallets can produce 65-byte signatures.

## SVM: agentic program payment verification

A Solana program cannot sign a transaction for its own address, so there is no signature to recover. `verifyAgenticProgramPayment` instead verifies the payment by simulating the fully signed transaction and enforcing invariants:

1. The payer program account is executable.
2. Optional unix-second timelock bounds hold.
3. The simulation succeeds with `sigVerify: true`.
4. The payer program set transaction return data equal to `x402_svm_ok_v1` (the parity concept to ERC-1271's magic value).
5. The payer program was invoked exactly once.
6. The fee payer's lamports are conserved, so the sponsor cannot be drained.
7. The recipient token account balance increased by at least `minAmount`.

```ts
import { createSolanaRpc } from "@solana/kit";
import { verifyAgenticProgramPayment } from "x402-sig-kit/svm";
import type { SvmRpcLike } from "x402-sig-kit/svm";

const rpc = createSolanaRpc("https://api.mainnet-beta.solana.com");

const result = await verifyAgenticProgramPayment({
  rpc: rpc as unknown as SvmRpcLike,
  signedTransaction, // base64 wire transaction, already signed by your fee payer
  feePayer,
  payerProgram,
  mint,
  payTo,
  minAmount: 1_000_000n,
});

if (result.ok) {
  // result.receivedAmount, result.recipientTokenAccount
} else {
  // result.reason is machine readable, e.g. "program_reentrancy"
}
```

The payer program signals success by setting return data:

```rust
use solana_program::program::set_return_data;

const SOLANA_MAGIC_OK: &[u8] = b"x402_svm_ok_v1";

// 1) Enforce whatever authorization policy the wallet requires.
// 2) Transfer tokens to the recipient token account (CPI to Token/Token-2022).
// 3) Signal verification success:
set_return_data(SOLANA_MAGIC_OK);
```

Also exported for facilitator-side checks:

- `feePayerAppearsInInstructionAccounts(txBase64, feePayer)` rejects transactions that pass the sponsoring fee payer into any instruction, where a program could mutate it.
- `findAssociatedTokenAccount({ owner, mint, tokenProgram })` derives the recipient ATA.
- Pure helpers: `checkReturnDataMagic`, `countProgramInvocations`, `parseTokenAmountFromParsedAccount`, `parseTimelock`, `checkTimelock`.

## Security notes

Read these before using the kit in a facilitator.

- The SVM path trusts the RPC node you point it at. A malicious node can fabricate simulation results. Use a node you control or trust.
- Simulation is point in time. State can change between verification and settlement. Re-verify at settlement, the same way the upstream x402 facilitator re-verifies before settling.
- The `x402_svm_ok_v1` return-data value is an opt-in convention between facilitator and payer program, not an on-chain standard.
- The reentrancy check counts `invoke` lines in simulation logs. RPC nodes truncate logs on very large transactions. If `logs` is truncated the count can be wrong, so bound transaction size in your own policy.
- The EVM `indeterminate` verdict means unverifiable now, not invalid. Only accept it when you can deploy the wallet at settlement time.
- ERC-1271 results depend on live contract state. A wallet can rotate owners between verification and settlement. Re-verify before settling.

## What changed relative to the original branches

The original work patched verification into the x402 facilitator schemes. This package extracts the logic with the x402 plumbing removed:

- The chain clients are injected (`EvmCodeReader`, `SvmRpcLike`) instead of being the facilitator's signer stack.
- EVM ECDSA verification uses pure local recovery instead of a signer-provided `verifyTypedData`.
- The SVM verifier takes a fully signed transaction. Signing stays with the caller.
- The EVM result is a three-state verdict (`valid`, `indeterminate`, `invalid`) instead of a config flag buried in the facilitator. The flag behavior is available via `isValidTypedDataSignature(params, { acceptUndeployedErc6492 })`.
- x402 scheme glue (instruction layout policing, payload decoding, error code names) stayed behind.

## Development

```bash
npm install
npm run build
npm test
```

## License

Apache-2.0. Portions derived from the x402 project, also Apache-2.0. See `LICENSE` and `NOTICE`.
