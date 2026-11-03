/**
 * Moon Forge oracle v2 — configuration.
 *
 * Everything that influences an epoch's result is either here (public, versioned)
 * or recorded inside the epoch JSON, so anyone can re-run `npm run verify` and
 * reproduce the exact Merkle root and data hash published on X1.
 */
import * as dotenv from "dotenv";
import * as fs from "fs";
import * as path from "path";
dotenv.config();

export const PROGRAM_ID = process.env.X1_PROGRAM_ID || "57UE1U1t23ztg2noLp8pcpGW1B1Xw25rLH6ra9Mchea9";
/** The default X1 endpoint, used before the built-in one when X1_RPC_URL is set (the workflows pass the repository variable; empty or blank = unset). */
export const X1_RPC_DEFAULT = "https://rpc.mainnet.x1.xyz";
export const x1RpcOf = (v: string | undefined): string => (v ?? "").trim() || X1_RPC_DEFAULT;
export const X1_RPC = x1RpcOf(process.env.X1_RPC_URL);
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
  /** primary RPC (= rpcs[0]) */
  rpc: string;
  /** RPCs tried in order; public endpoints differ in how much eth_getLogs history they serve for free */
  rpcs: string[];
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

/**
 * Comma-separated RPC list from the environment (or the default list). The workflows pass `<CHAIN>_RPC_URL` from the
 * repository variable of that name, so an unset variable arrives as "": that, or a value with no entry at all (blanks,
 * commas), means the default list, never an empty one (pure; tested).
 */
export function rpcListOf(v: string | undefined, d: string): string[] {
  const list = (v ?? "").split(",").map((u) => u.trim()).filter(Boolean);
  return list.length ? list : d.split(",").map((u) => u.trim()).filter(Boolean);
}
const rpcList = (k: string, d: string) => rpcListOf(process.env[k], d);

/**
 * The deployed portals (deployments/portals.json) are the default of PORTAL_<X> / START_<X>, so a verifier, a seat
 * taker or a fork with no repository variables reads the same five chains as the project's workflows. A variable that
 * is UNSET takes this default; a variable set to "" skips the chain (tests/e2e-oracle-v3.sh does that). START_<X>
 * defaults to the deploy block only when the portal is the deployed one; with a portal from the environment it stays 0.
 */
function deployedPortals(): Map<number, { address: string; deployBlock: number }> {
  const out = new Map<number, { address: string; deployBlock: number }>();
  try {
    const j = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "deployments", "portals.json"), "utf8"));
    for (const p of j?.portals ?? []) {
      if (/^0x[0-9a-fA-F]{40}$/.test(String(p.address)) && Number.isSafeInteger(Number(p.deployBlock))) {
        out.set(Number(p.chainId), { address: String(p.address), deployBlock: Number(p.deployBlock) });
      }
    }
  } catch {
    // not a full checkout (no deployments/): no default, as before
  }
  return out;
}
export const DEPLOYED_PORTALS = deployedPortals();

/** Pure; tested: a chain's portal and start block from the environment `e`, else from the deployed portals. */
export function portalSetting(
  portalVar: string, startVar: string, chainId: number,
  e: Record<string, string | undefined> = process.env, deployed: Map<number, { address: string; deployBlock: number }> = DEPLOYED_PORTALS,
): { portal: string; startBlock: number } {
  const fromFile = e[portalVar] === undefined;
  const portal = fromFile ? deployed.get(chainId)?.address ?? "" : e[portalVar]!;
  const startBlock = Number(e[startVar] || (fromFile ? deployed.get(chainId)?.deployBlock ?? 0 : 0));
  return { portal, startBlock };
}
const portalOf = (k: string, chainId: number) => portalSetting(k, k.replace(/^PORTAL_/, "START_"), chainId).portal;
const startOf = (k: string, portalVar: string, chainId: number) => portalSetting(portalVar, k, chainId).startBlock;

// RPC lists: endpoints checked on 2026-10-12 to serve eth_getLogs over week-old blocks without an API key
// (publicnode now refuses those "archive" requests without a personal token). Override with e.g. BASE_RPC_URL=a,b
// D-53 (round 4): the five chains with a portal only; Ethereum, PulseChain and Moonbeam have no entry (no portal: Moon
// Forge launches with side-chain XEN, Ethereum XEN has its own path, PulseChain and Moonbeam have no priced market). A
// chain added later is a new, reviewed entry here with its portal.
// O-22 / T1-10: the BSC entry that carries a shared public NodeReal key (published in many places, rate-limited for
// everyone using it) is the LAST resort, never the primary; the keyless endpoints come first.
const RAW_CHAINS: Omit<ChainConfig, "rpc">[] = [
  { chainId: 10, name: "Optimism", rpcs: rpcList("OP_RPC_URL", "https://mainnet.optimism.io,https://optimism.gateway.tenderly.co,https://optimism-rpc.publicnode.com"), portal: portalOf("PORTAL_OP", 10), startBlock: startOf("START_OP", "PORTAL_OP", 10), confirmations: 120, logChunk: 10_000, xen: "0xeB585163DEbB1E637c6D617de3bEF99347cd75c8", gecko: "optimism" },
  { chainId: 56, name: "BSC", rpcs: rpcList("BSC_RPC_URL", "https://bsc.rpc.blxrbdn.com,https://bsc-rpc.publicnode.com,https://bsc-mainnet.nodereal.io/v1/64a9df0874fb4a93b9d0a3849de012d3"), portal: portalOf("PORTAL_BSC", 56), startBlock: startOf("START_BSC", "PORTAL_BSC", 56), confirmations: 30, logChunk: 5_000, xen: "0x2AB0e9e4eE70FFf1fB9D67031E44F6410170d00e", gecko: "bsc" },
  { chainId: 137, name: "Polygon", rpcs: rpcList("POLYGON_RPC_URL", "https://polygon.gateway.tenderly.co,https://polygon-bor-rpc.publicnode.com"), portal: portalOf("PORTAL_POLYGON", 137), startBlock: startOf("START_POLYGON", "PORTAL_POLYGON", 137), confirmations: 256, logChunk: 3_000, xen: "0x2AB0e9e4eE70FFf1fB9D67031E44F6410170d00e", gecko: "polygon_pos" },
  { chainId: 43114, name: "Avalanche", rpcs: rpcList("AVAX_RPC_URL", "https://api.avax.network/ext/bc/C/rpc,https://avalanche-c-chain-rpc.publicnode.com"), portal: portalOf("PORTAL_AVAX", 43114), startBlock: startOf("START_AVAX", "PORTAL_AVAX", 43114), confirmations: 30, logChunk: 2_000, xen: "0xC0C5AA69Dbe4d6DDdfBc89c0957686ec60F24389", gecko: "avax" },
  { chainId: 8453, name: "Base", rpcs: rpcList("BASE_RPC_URL", "https://base.gateway.tenderly.co,https://mainnet.base.org,https://base-rpc.publicnode.com"), portal: portalOf("PORTAL_BASE", 8453), startBlock: startOf("START_BASE", "PORTAL_BASE", 8453), confirmations: 120, logChunk: 1_000, xen: "0xffcbF84650cE02DaFE96926B37a0ac5E34932fa5", gecko: "base" },
];
export const CHAINS: ChainConfig[] = RAW_CHAINS.map((c) => ({ ...c, rpc: c.rpcs[0] }));

export const PORTAL_ABI = [
  "event MissionStarted(uint256 indexed missionId, address indexed pilot, uint256 amount, uint8 tier, bytes32 x1Pubkey, uint256 chainId, uint256 timestamp)",
];

/** Oracle signer: JSON array (solana-keygen) or Base58 secret key. Never commit it. */
export const ORACLE_PRIVATE_KEY = process.env.ORACLE_PRIVATE_KEY || "";
/** Optional manual XNT price override (USD), e.g. if the price APIs are down. Recorded in the epoch file. */
export const XNT_USD_OVERRIDE = process.env.XNT_USD_OVERRIDE || "";
