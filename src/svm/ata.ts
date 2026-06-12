import { getAddressEncoder, getProgramDerivedAddress } from "@solana/kit";
import type { Address } from "@solana/kit";
import { ASSOCIATED_TOKEN_PROGRAM_ADDRESS } from "./constants.js";

/**
 * Derive the associated token account for an owner, mint, and token program.
 *
 * @param args - Owner wallet, token mint, and owning token program.
 * @returns The associated token account address.
 */
export async function findAssociatedTokenAccount(args: {
  owner: string;
  mint: string;
  tokenProgram: string;
}): Promise<string> {
  const encoder = getAddressEncoder();
  const [pda] = await getProgramDerivedAddress({
    programAddress: ASSOCIATED_TOKEN_PROGRAM_ADDRESS as Address,
    seeds: [
      encoder.encode(args.owner as Address),
      encoder.encode(args.tokenProgram as Address),
      encoder.encode(args.mint as Address),
    ],
  });
  return pda;
}
