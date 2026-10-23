/**
 * X1 destination safety check for The Forge (R5). This is a safety check, not a terms gate: it only refuses
 * addresses that can never receive or use XNT, and asks for a second confirmation on unusual ones.
 *
 *   1. Hard block (sync): the all-zero key and a denylist of addresses that are programs, sysvars or protocol
 *      accounts. A claim credits lamports to the burn's destination; an executable or reserved account can never
 *      be written and can never sign, so XNT sent there is lost for good.
 *   2. On-chain look-up (one getAccountInfo, read-only): an executable account is blocked; an existing account owned
 *      by anything other than the System program (a token account, a program's data account, a stake account…) needs
 *      a red second checkbox. A missing account is normal (a fresh wallet).
 * Nothing leaves the browser except that one read to the X1 RPC already used by every page.
 */
import { PublicKey } from '@solana/web3.js';
import { MPL_CORE, PDA, PROGRAM_ID, readConnection, WXNT_MINT } from './protocol';

const SYSTEM_PROGRAM = '11111111111111111111111111111111';

/** Programs, loaders, sysvars and well-known reserved accounts (base58, compared as strings). */
const RESERVED: Readonly<Record<string, string>> = {
  [SYSTEM_PROGRAM]: 'the System program',
  TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA: 'the SPL Token program',
  TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb: 'the Token-2022 program',
  ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL: 'the Associated Token Account program',
  MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr: 'the Memo program',
  ComputeBudget111111111111111111111111111111: 'the Compute Budget program',
  AddressLookupTab1e1111111111111111111111111: 'the Address Lookup Table program',
  Vote111111111111111111111111111111111111111: 'the Vote program',
  Stake11111111111111111111111111111111111111: 'the Stake program',
  Config1111111111111111111111111111111111111: 'the Config program',
  Ed25519SigVerify111111111111111111111111111: 'the Ed25519 program',
  KeccakSecp256k11111111111111111111111111111: 'the Secp256k1 program',
  NativeLoader1111111111111111111111111111111: 'the native loader',
  BPFLoader1111111111111111111111111111111111: 'a BPF loader',
  BPFLoader2111111111111111111111111111111111: 'a BPF loader',
  BPFLoaderUpgradeab1e11111111111111111111111: 'the upgradeable BPF loader',
  LoaderV411111111111111111111111111111111111: 'a BPF loader',
  SysvarC1ock11111111111111111111111111111111: 'a sysvar (Clock)',
  SysvarRent111111111111111111111111111111111: 'a sysvar (Rent)',
  SysvarS1otHashes111111111111111111111111111: 'a sysvar (SlotHashes)',
  SysvarS1otHistory11111111111111111111111111: 'a sysvar (SlotHistory)',
  SysvarRecentB1ockHashes11111111111111111111: 'a sysvar (RecentBlockhashes)',
  SysvarEpochSchedu1e111111111111111111111111: 'a sysvar (EpochSchedule)',
  SysvarEpochRewards1111111111111111111111111: 'a sysvar (EpochRewards)',
  SysvarFees111111111111111111111111111111111: 'a sysvar (Fees)',
  Sysvar1nstructions1111111111111111111111111: 'a sysvar (Instructions)',
  SysvarStakeHistory1111111111111111111111111: 'a sysvar (StakeHistory)',
  SysvarLastRestartS1ot1111111111111111111111: 'a sysvar (LastRestartSlot)',
  '1nc1nerator11111111111111111111111111111111': 'the incinerator (burn address)',
};

let protocolDeny: Map<string, string> | null = null;
/** The Moon Forge program, its PDAs, Metaplex Core and the WXNT mint (built lazily: PDA derivation is cheap but not free). */
function protocolAccounts(): Map<string, string> {
  if (protocolDeny) return protocolDeny;
  const m = new Map<string, string>();
  const add = (k: PublicKey, what: string) => m.set(k.toBase58(), what);
  add(PROGRAM_ID, 'the Moon Forge program itself');
  add(PDA.config(), 'the Moon Forge config account');
  add(PDA.rewardVault(), 'the Moon Forge reward pool vault');
  add(PDA.bankrollVault(), 'the Moon Forge game bankroll vault');
  add(PDA.drawVault(), 'the Moon Forge lottery vault');
  add(PDA.collection(), 'the Moon Forge Artifacts collection');
  add(PDA.artifactAuthority(), 'the Moon Forge Artifact authority');
  add(MPL_CORE, 'the Metaplex Core program');
  add(WXNT_MINT, 'the wrapped XNT mint');
  protocolDeny = m;
  return m;
}

/** Why `pk` can never be a burn destination, or null when it is not on the denylist. */
export function deniedDestination(pk: PublicKey): string | null {
  const b58 = pk.toBase58();
  return RESERVED[b58] ?? protocolAccounts().get(b58) ?? null;
}

export type DestinationKind =
  | { kind: 'new' }                                  // no account yet: a fresh wallet (normal)
  | { kind: 'wallet' }                               // System-owned, not executable: a regular wallet
  | { kind: 'executable'; owner: string }            // a program: can never be credited
  | { kind: 'owned'; owner: string; ownerName: string | null } // owned by another program: unusual, second confirmation
  | { kind: 'unknown' };                             // the RPC read failed

/** One read-only getAccountInfo on the X1 RPC. */
export async function inspectDestination(pk: PublicKey): Promise<DestinationKind> {
  try {
    const info = await readConnection.getAccountInfo(pk, 'confirmed');
    if (!info) return { kind: 'new' };
    const owner = info.owner.toBase58();
    if (info.executable) return { kind: 'executable', owner };
    if (owner === SYSTEM_PROGRAM) return { kind: 'wallet' };
    return { kind: 'owned', owner, ownerName: RESERVED[owner] ?? protocolAccounts().get(owner) ?? null };
  } catch {
    return { kind: 'unknown' };
  }
}
