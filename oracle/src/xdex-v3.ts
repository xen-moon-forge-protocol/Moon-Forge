/**
 * D-22 (a) and the agent kit's market route (FEED CONTRACT `xdex`): the XDEX WXNT/USDC.X pool read on X1, read-only.
 * XDEX is a Raydium-CPMM fork (programs/moon-forge/src/constants.rs XDEX_PROGRAM): the pool state holds the two vaults and
 * the fees the pool owes its protocol and fund, and the reserve a swap trades against is each vault's balance less those
 * fees (Raydium CPMM vault_amount_without_fee). The layout below was checked against the live pool on 2026-10-25 (owner
 * sEsYH97…, 637 bytes, token 0 = WXNT So111… with 9 decimals, token 1 = USDC.X B69chRz… with 6 decimals, the observation
 * account 4oUvUg… that the program's Predictions and pricing.ts xntTwapOnChain read).
 */
import { Commitment, Connection, PublicKey } from "@solana/web3.js";
import { XdexReadingV3 } from "./rewards";

/** the pool every v3 payout is priced on (pricing.ts XNT_POOL_X1, constants.rs XDEX_XNT_POOL) */
export const XDEX_POOL_V3 = "CAJeVEoSm1QQZccnCqYu9cnNF7TTD2fcUA3E5HQoxRvR";
export const XDEX_PROGRAM_V3 = "sEsYH97wqmfnkzHedjNcw3zyJdPvUmsa9AixhS4b4fN";
/**
 * D-22 (b): the candidate XNT/USD price pools (XDEX CPMM pools of WXNT against USDC.X). Today the one pool every payout and
 * the program's Predictions read; a deeper pool is added here by a reviewed change, and takes over by the switch rule
 * (rewards.ts xntPoolRecordV3) only after it has been more than 2× deeper for 2 builds, announced one epoch ahead.
 */
export const XNT_POOL_CANDIDATES_V3: readonly string[] = Object.freeze([XDEX_POOL_V3]);
/** wrapped XNT (the native mint) */
export const WXNT_MINT = "So11111111111111111111111111111111111111112";
/** Raydium CPMM: trade_fee_rate is in millionths */
const FEE_RATE_DENOMINATOR = 1_000_000n;

/** The fields of a Raydium-CPMM PoolState this reader uses (offsets after the 8-byte discriminator). */
export interface CpmmPoolV3 {
  ammConfig: string;
  vault0: string;
  vault1: string;
  mint0: string;
  mint1: string;
  decimals0: number;
  decimals1: number;
  /** protocol + fund fees owed, per token (never part of the tradable reserve) */
  fees0: bigint;
  fees1: bigint;
}

const key = (d: Buffer, o: number) => new PublicKey(d.subarray(o, o + 32)).toBase58();

/** Parses a Raydium-CPMM PoolState (throws on a short account). */
export function parseCpmmPoolV3(data: Buffer): CpmmPoolV3 {
  if (data.length < 373) throw new Error(`XDEX pool state is ${data.length} bytes, not a CPMM PoolState`);
  return {
    ammConfig: key(data, 8), vault0: key(data, 72), vault1: key(data, 104), mint0: key(data, 168), mint1: key(data, 200),
    decimals0: data[331], decimals1: data[332],
    fees0: data.readBigUInt64LE(341) + data.readBigUInt64LE(357),
    fees1: data.readBigUInt64LE(349) + data.readBigUInt64LE(365),
  };
}

/** The amount of an SPL token account (Token and Token-2022 share the first 165 bytes: amount at offset 64). */
export function tokenAmountV3(data: Buffer, mint: string): bigint {
  if (data.length < 72) throw new Error("not a token account");
  if (key(data, 0) !== mint) throw new Error(`a vault holds mint ${key(data, 0)}, not ${mint}`);
  return data.readBigUInt64LE(64);
}

/**
 * The reading recorded in a v3 file (pure): the WXNT side and the USDC.X side (whichever token the pool lists first), each
 * vault less the fees owed, and the trade fee in basis points (rounded down) from the AMM config.
 */
export function xdexReadingFromV3(pool: string, slot: number, p: CpmmPoolV3, amount0: bigint, amount1: bigint, ammConfig: Buffer): XdexReadingV3 {
  const wxntIs0 = p.mint0 === WXNT_MINT;
  if (!wxntIs0 && p.mint1 !== WXNT_MINT) throw new Error(`pool ${pool} has no WXNT side`);
  if ((wxntIs0 ? p.decimals0 : p.decimals1) !== 9 || (wxntIs0 ? p.decimals1 : p.decimals0) !== 6) throw new Error(`pool ${pool}: unexpected decimals (${p.decimals0}, ${p.decimals1})`);
  const r0 = amount0 > p.fees0 ? amount0 - p.fees0 : 0n;
  const r1 = amount1 > p.fees1 ? amount1 - p.fees1 : 0n;
  if (ammConfig.length < 20) throw new Error("XDEX amm config too short");
  const tradeFee = ammConfig.readBigUInt64LE(12);
  const feeBps = Number((tradeFee * 10_000n) / FEE_RATE_DENOMINATOR);
  return {
    pool, slot,
    wxntReserveLamports: (wxntIs0 ? r0 : r1).toString(),
    usdcReserveMicro: (wxntIs0 ? r1 : r0).toString(),
    feeBps,
  };
}

/** Reads the pool, its two vaults and its AMM config at one slot (read-only). */
export async function readXdexV3(connection: Connection, commitment: Commitment = "finalized", pool = XDEX_POOL_V3): Promise<XdexReadingV3> {
  const st = await connection.getAccountInfoAndContext(new PublicKey(pool), commitment);
  if (!st.value) throw new Error(`XDEX pool ${pool} not found`);
  if (st.value.owner.toBase58() !== XDEX_PROGRAM_V3) throw new Error(`XDEX pool ${pool} is owned by ${st.value.owner.toBase58()}, not XDEX`);
  const p = parseCpmmPoolV3(Buffer.from(st.value.data));
  const infos = await connection.getMultipleAccountsInfoAndContext([new PublicKey(p.vault0), new PublicKey(p.vault1), new PublicKey(p.ammConfig)], { commitment, minContextSlot: st.context.slot });
  const [v0, v1, cfg] = infos.value;
  if (!v0 || !v1 || !cfg) throw new Error(`XDEX pool ${pool}: a vault or the AMM config could not be read`);
  return xdexReadingFromV3(pool, infos.context.slot, p, tokenAmountV3(Buffer.from(v0.data), p.mint0), tokenAmountV3(Buffer.from(v1.data), p.mint1), Buffer.from(cfg.data));
}
