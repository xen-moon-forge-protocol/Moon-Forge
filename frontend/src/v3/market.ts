/**
 * Native Artifact market of the upgraded program (rules 3): the fee split of a sale, mirrored from
 * programs/moon-forge/src/utils.rs market_split. 5% royalty to the architect (the payee in Config.architect, which
 * set_architect can rotate or renounce; the reward pool when that wallet would stay below rent), 2% to the BASE pot (reward_vault). Nothing goes to the
 * extra pot and nothing to the lottery (WP-frontend must-not: market fees are never shown as going to the extra pot).
 */
import { BPS, MARKET_POOL_BPS, MARKET_ROYALTY_BPS } from './constants';

export function marketSplit(price: bigint) {
    const royalty = (price * MARKET_ROYALTY_BPS) / BPS;
    const poolFee = (price * MARKET_POOL_BPS) / BPS;
    return { royalty, poolFee, sellerNet: price - royalty - poolFee };
}

/** The lowest list price that still pays the seller at least `backing` after both fees (net = 93% of the price). */
export function minListPriceForFloor(backing: bigint): bigint {
    // smallest p with p − ⌊p·500/10⁴⌋ − ⌊p·200/10⁴⌋ ≥ backing
    let p = (backing * BPS + (BPS - MARKET_ROYALTY_BPS - MARKET_POOL_BPS) - 1n) / (BPS - MARKET_ROYALTY_BPS - MARKET_POOL_BPS);
    while (p > 0n && marketSplit(p - 1n).sellerNet >= backing) p -= 1n;
    while (marketSplit(p).sellerNet < backing) p += 1n;
    return p;
}

/** The sentence every market surface shows (CLAIMS.md B2/E5 after the upgrade). */
export const MARKET_FEES_LINE = 'Each native sale pays a 5% royalty to the architect and 2% to the base pot (the reward pool burners are paid from); nothing goes to the extra pot. The seller receives the other 93% and never less than the Artifact’s floor.';
