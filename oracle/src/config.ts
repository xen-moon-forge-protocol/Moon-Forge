/**
 * Moon Forge oracle v2 — configuration.
 *
 * Everything that influences an epoch's result is either here (public, versioned)
 * or recorded inside the epoch JSON, so anyone can re-run `npm run verify` and
 * reproduce the exact Merkle root and data hash published on X1.
 */
import * as dotenv from "dotenv";
dotenv.config();

export const PROGRAM_ID = process.env.X1_PROGRAM_ID || "57UE1U1t23ztg2noLp8pcpGW1B1Xw25rLH6ra9Mchea9";
export const X1_RPC = process.env.X1_RPC_URL || "https://rpc.mainnet.x1.xyz";
/** Directory with epoch JSON files (served by GitHub Pages for the frontend). */
export const EPOCHS_DIR = process.env.EPOCHS_DIR || "../frontend/public/epochs";

/**
 * Payout policy: XNT paid per USD of XEN burned is capped at K × market price of XNT.
 * K = 1.25 → Launchpad receives up to 1.25× the market value of the XEN it burned,
 * Orbit 2.5× (45 d vesting), Moon Landing 3.75× (180 d vesting).
 * The cap only LOWERS the on-chain budget (min(10% free pool, total_score × rate_cap)).
 * Rationale: XEN is mintable forever, a bigger premium would be farmed by mint-and-burn.
 */
export const RATE_CAP_K = Number(process.env.RATE_CAP_K || "1.25");
/** Max allowed change of a chain's XEN price vs the previous epoch (anti-manipulation clamp). */
export const MAX_PRICE_MOVE = Number(process.env.MAX_PRICE_MOVE || "0.5"); // ±50%
export const TIER_MULTIPLIER = [1n, 2n, 3n];
export const ARTIFACT_BOOST_BPS = [500, 1000, 2000, 5000];

export interface ChainConfig {
  chainId: number;
  name: string;
  rpc: string;
  /** MoonForgePortal v2 address on this chain ("" = not deployed yet, chain skipped) */
  portal: string;
  /** Block where the portal was deployed (scan start for epoch 1) */
  startBlock: number;
  /** Confirmations before a burn is final enough to be paid */
  confirmations: number;
  /** eth_getLogs block range per request */
  logChunk: number;
  xen: string;
  /** GeckoTerminal network slug for the XEN price */
  gecko: string;
}

const env = (k: string, d = "") => process.env[k] || d;

export const CHAINS: ChainConfig[] = [
  { chainId: 1, name: "Ethereum", rpc: env("ETH_RPC_URL", "https://ethereum-rpc.publicnode.com"), portal: env("PORTAL_ETH"), startBlock: Number(env("START_ETH", "0")), confirmations: 64, logChunk: 5_000, xen: "0x06450dEe7FD2Fb8E39061434BAbCFC05599a6Fb8", gecko: "eth" },
  { chainId: 10, name: "Optimism", rpc: env("OP_RPC_URL", "https://optimism-rpc.publicnode.com"), portal: env("PORTAL_OP"), startBlock: Number(env("START_OP", "0")), confirmations: 120, logChunk: 10_000, xen: "0xeB585163DEbB1E637c6D617de3bEF99347cd75c8", gecko: "optimism" },
  { chainId: 56, name: "BSC", rpc: env("BSC_RPC_URL", "https://bsc-rpc.publicnode.com"), portal: env("PORTAL_BSC"), startBlock: Number(env("START_BSC", "0")), confirmations: 30, logChunk: 5_000, xen: "0x2AB0e9e4eE70FFf1fB9D67031E44F6410170d00e", gecko: "bsc" },
  { chainId: 137, name: "Polygon", rpc: env("POLYGON_RPC_URL", "https://polygon-bor-rpc.publicnode.com"), portal: env("PORTAL_POLYGON"), startBlock: Number(env("START_POLYGON", "0")), confirmations: 256, logChunk: 3_000, xen: "0x2AB0e9e4eE70FFf1fB9D67031E44F6410170d00e", gecko: "polygon_pos" },
  { chainId: 43114, name: "Avalanche", rpc: env("AVAX_RPC_URL", "https://avalanche-c-chain-rpc.publicnode.com"), portal: env("PORTAL_AVAX"), startBlock: Number(env("START_AVAX", "0")), confirmations: 30, logChunk: 2_000, xen: "0xC0C5AA69Dbe4d6DDdfBc89c0957686ec60F24389", gecko: "avax" },
  { chainId: 8453, name: "Base", rpc: env("BASE_RPC_URL", "https://base-rpc.publicnode.com"), portal: env("PORTAL_BASE"), startBlock: Number(env("START_BASE", "0")), confirmations: 120, logChunk: 10_000, xen: "0xffcbF84650cE02DaFE96926B37a0ac5E34932fa5", gecko: "base" },
  { chainId: 369, name: "PulseChain", rpc: env("PULSE_RPC_URL", "https://pulsechain-rpc.publicnode.com"), portal: env("PORTAL_PULSE"), startBlock: Number(env("START_PULSE", "0")), confirmations: 30, logChunk: 5_000, xen: "0x8a7FDcA264e87b6da72D000f22186B4403081A2a", gecko: "pulsechain" },
  // Moonbeam: verified XEN contract, but no priced market on 2026-10-07 → burns would score zero. No portal planned.
  { chainId: 1284, name: "Moonbeam", rpc: env("MOONBEAM_RPC_URL", "https://moonbeam-rpc.publicnode.com"), portal: env("PORTAL_MOONBEAM"), startBlock: Number(env("START_MOONBEAM", "0")), confirmations: 30, logChunk: 5_000, xen: "0xb564A5767A00Ee9075cAC561c427643286F8F4E1", gecko: "glmr" },
];

export const PORTAL_ABI = [
  "event MissionStarted(uint256 indexed missionId, address indexed pilot, uint256 amount, uint8 tier, bytes32 x1Pubkey, uint256 chainId, uint256 timestamp)",
];

/** Oracle signer: JSON array (solana-keygen) or Base58 secret key. Never commit it. */
export const ORACLE_PRIVATE_KEY = process.env.ORACLE_PRIVATE_KEY || "";
/** Optional manual XNT price override (USD), e.g. if the price APIs are down. Recorded in the epoch file. */
export const XNT_USD_OVERRIDE = process.env.XNT_USD_OVERRIDE || "";
