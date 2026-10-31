/**
 * Which program rules are live: 2 (the deployed v2 binary, tag program-2026-10-12), 3 (the final upgrade, once its
 * first-run accounts exist) or 'unknown' (a half-done upgrade, an unreadable answer). Read-only, three RPC reads.
 *
 * On X1 mainnet this is the oracle's own verdict (oracle/src/x1-v3.ts readUpgradeProbeV3 / upgradeVerdictV3, W2-4):
 *   upgraded  ProgramData last-deploy slot > 85,429,880 AND the ExtraState PDA (init_extra) AND the OracleSeat PDA
 *             (init_seat) exist, are owned by the program, have their exact sizes, decode with the upgraded program's
 *             IDL and carry the canonical bump (ExtraState: reserved ≤ accounted; OracleSeat: generation ≥ 1)
 *   legacy    exactly today's state: last-deploy slot 85,429,880 and none of the upgraded-only accounts
 *   unknown   anything else; the kit then refuses every transaction (fail closed) until the state is clear
 * On any other cluster (a local validator, which may load the program without the upgradeable loader) only the
 * ExtraState PDA is read: present and decodable → 3, absent → 2.
 */
import { PublicKey } from '@solana/web3.js';
import { redactUrls } from './errors.mjs';

export const PROGRAM_ID = new PublicKey('57UE1U1t23ztg2noLp8pcpGW1B1Xw25rLH6ra9Mchea9');
export const BPF_LOADER_UPGRADEABLE = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');
export const X1_MAINNET_GENESIS = '4SvBP3omtvcCVWdxq1zBY5cDp4wndjsThb6nEMn6iMdN';
/** ProgramData last-deploy slot of the live v2 binary (tag program-2026-10-12). */
export const LIVE_DEPLOY_SLOT = 85_429_880;
export const EXTRA_STATE_SIZE = 90;
export const ORACLE_SEAT_SIZE = 157;
const pdaOf = (seed) => PublicKey.findProgramAddressSync([Buffer.from(seed)], PROGRAM_ID);
export const PDA_V3 = Object.freeze({
  extraState: () => pdaOf('extra_state')[0],
  extraVault: () => pdaOf('extra_vault')[0],
  oracleSeat: () => pdaOf('oracle_seat')[0],
  houseKeeper: () => pdaOf('house_keeper')[0],
  extraEpoch: (id) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(id)); return PublicKey.findProgramAddressSync([Buffer.from('extra_epoch'), b], PROGRAM_ID)[0]; },
  listing: (asset) => PublicKey.findProgramAddressSync([Buffer.from('listing'), new PublicKey(asset).toBuffer()], PROGRAM_ID)[0],
});

/** Reads the probe (program account, a 45-byte slice of ProgramData, the three upgraded-only PDAs) at one commitment. */
export async function readUpgradeProbe(connection, { commitment = 'confirmed', mainnet = true } = {}) {
  const empty = { deploySlot: null, extraState: null, oracleSeat: null, houseKeeper: null };
  const pick = (a) => (a ? { owner: a.owner, data: Buffer.from(a.data) } : null);
  if (!mainnet) {
    const [x, s, k] = await connection.getMultipleAccountsInfo([PDA_V3.extraState(), PDA_V3.oracleSeat(), PDA_V3.houseKeeper()], commitment);
    return { ...empty, extraState: pick(x), oracleSeat: pick(s), houseKeeper: pick(k) };
  }
  const prog = await connection.getAccountInfo(PROGRAM_ID, commitment);
  if (!prog) return { ...empty, error: `the program account ${PROGRAM_ID.toBase58()} is missing` };
  if (!prog.owner.equals(BPF_LOADER_UPGRADEABLE) || prog.data.length < 36 || prog.data.readUInt32LE(0) !== 2) {
    return { ...empty, error: 'the program account is not an upgradeable-loader Program account' };
  }
  const programData = new PublicKey(prog.data.subarray(4, 36));
  const head = await connection.getAccountInfo(programData, { commitment, dataSlice: { offset: 0, length: 45 } });
  if (!head || !head.owner.equals(BPF_LOADER_UPGRADEABLE) || head.data.length < 12 || head.data.readUInt32LE(0) !== 3) {
    return { ...empty, error: `the ProgramData account ${programData.toBase58()} is missing or not a ProgramData account` };
  }
  const deploySlot = Number(head.data.readBigUInt64LE(4));
  const [x, s, k] = await connection.getMultipleAccountsInfo([PDA_V3.extraState(), PDA_V3.oracleSeat(), PDA_V3.houseKeeper()], commitment);
  return { deploySlot, extraState: pick(x), oracleSeat: pick(s), houseKeeper: pick(k) };
}

/**
 * Pure verdict over a probe. `decode(name, data)` decodes an account with the upgraded program's IDL (throws when the
 * discriminator or layout does not match). Returns { rules: 2 | 3 | 'unknown', status, reasons[], deploySlot }.
 */
export function upgradeVerdict(p, decode, { mainnet = true } = {}) {
  const reasons = [];
  if (p.error) return { rules: 'unknown', status: 'unknown', reasons: [p.error], deploySlot: p.deploySlot ?? null };
  const bump = (seed) => pdaOf(seed)[1];
  const check = (what, a, name, size, sane) => {
    if (!a) return void reasons.push(`${what} does not exist`);
    if (!a.owner.equals(PROGRAM_ID)) return void reasons.push(`${what} is owned by ${a.owner.toBase58()}, not the program`);
    if (a.data.length !== size) return void reasons.push(`${what} has ${a.data.length} bytes, not ${size}`);
    let d;
    try { d = decode(name, a.data); } catch (e) { return void reasons.push(`${what} does not decode as the upgraded program's ${name} (${String(e?.message ?? e).slice(0, 80)})`); }
    const bad = sane(d);
    if (bad) reasons.push(`${what}: ${bad}`);
  };
  const extraOk = (d) => (Number(d.bump) !== bump('extra_state') ? `bump ${d.bump} is not the PDA's` : BigInt(d.reserved.toString()) > BigInt(d.accounted.toString()) ? 'reserved above accounted' : null);
  if (!mainnet) {
    if (!p.extraState) return { rules: 2, status: 'legacy', reasons: ['ExtraState (init_extra) does not exist on this cluster'], deploySlot: null };
    check('ExtraState (init_extra)', p.extraState, 'ExtraState', EXTRA_STATE_SIZE, extraOk);
    return reasons.length ? { rules: 'unknown', status: 'unknown', reasons, deploySlot: null } : { rules: 3, status: 'upgraded', reasons: [], deploySlot: null };
  }
  if (p.deploySlot === null || !Number.isSafeInteger(p.deploySlot)) reasons.push('the ProgramData last-deploy slot is unreadable');
  else if (p.deploySlot <= LIVE_DEPLOY_SLOT) reasons.push(`the ProgramData last-deploy slot ${p.deploySlot} is not after ${LIVE_DEPLOY_SLOT} (the live v2 binary)`);
  check('ExtraState (init_extra)', p.extraState, 'ExtraState', EXTRA_STATE_SIZE, extraOk);
  check('OracleSeat (init_seat)', p.oracleSeat, 'OracleSeat', ORACLE_SEAT_SIZE, (d) => (Number(d.bump) !== bump('oracle_seat') ? `bump ${d.bump} is not the PDA's` : BigInt(d.generation.toString()) < 1n ? 'generation 0' : null));
  if (!reasons.length) return { rules: 3, status: 'upgraded', reasons: [], deploySlot: p.deploySlot };
  const legacy = p.deploySlot === LIVE_DEPLOY_SLOT && !p.extraState && !p.oracleSeat && !p.houseKeeper;
  return { rules: legacy ? 2 : 'unknown', status: legacy ? 'legacy' : 'unknown', reasons, deploySlot: p.deploySlot };
}

/**
 * Reads and judges in one call; an RPC error is 'unknown' (fail closed) with `transient: true` (the caller may keep an
 * earlier clear reading and retry soon). The error text is cut to the URL origins: a private endpoint's API key in its
 * path or query never reaches a reason, a warning or status().
 */
export async function detectRules(connection, decode, { mainnet = true, commitment = 'confirmed' } = {}) {
  let probe;
  let transient = false;
  try { probe = await readUpgradeProbe(connection, { commitment, mainnet }); } catch (e) {
    transient = true;
    probe = { deploySlot: null, extraState: null, oracleSeat: null, houseKeeper: null, error: `RPC error: ${redactUrls(String(e?.message ?? e)).slice(0, 160)}` };
  }
  return { ...upgradeVerdict(probe, decode, { mainnet }), ...(transient ? { transient: true } : {}), at: Date.now() };
}
