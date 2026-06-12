/**
 * Magic value an agentic payer program must set as transaction return data
 * during simulation to signal successful payment authorization.
 *
 * Parity concept with EIP-1271's `isValidSignature` magic value on EVM.
 */
export const SOLANA_MAGIC_OK = "x402_svm_ok_v1";

/** SPL Token program. */
export const TOKEN_PROGRAM_ADDRESS = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

/** SPL Token-2022 program. */
export const TOKEN_2022_PROGRAM_ADDRESS = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

/** Associated Token Account program. */
export const ASSOCIATED_TOKEN_PROGRAM_ADDRESS = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";

/** SPL Memo program. */
export const MEMO_PROGRAM_ADDRESS = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";

/**
 * Lighthouse program. Phantom and Solflare inject Lighthouse instructions
 * into mainnet transactions as user protection.
 */
export const LIGHTHOUSE_PROGRAM_ADDRESS = "L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95";
