// Safety: the notices the owner accepts, the kill switch, and key loading that never prints a key.
import fs from 'node:fs';

export const RISK_NOTICE = [
  'Moon Forge Bot is community software, provided as is, under the MIT license, with no warranty.',
  'A burn destroys XEN for good. The payout is XNT on X1, under the rules of the epoch the burn falls in; no payout is promised.',
  'The reward pool is small (about 6.5 XNT on 2026-11-02): one week can pay at most about 0.65 XNT to all burners together under the current rules.',
  'If the GitHub account falls, the site, the oracle, the keeper and the epoch files stop; payouts pause; the reward pool stays locked in the program.',
  'Games are games of chance or player-versus-player stakes: you can lose the whole stake. Not for anyone under 18, and not where such games are prohibited.',
  'You run the bot and hold its keys: you are responsible for what it does. Fund its wallets only with what it may spend.',
].join('\n');

export const GAMES_NOTICE = 'Games: 18+ only and only where legal. You can lose the whole stake. House games carry a fixed 2% edge. '
  + 'Your opponent may be another automated agent.';

/** The kill switch: a file (any content) or MFBOT_STOP=1. While it is on, the bot sends nothing and exits the loop. */
export function killSwitchOn(cfg, env = process.env) {
  if (env.MFBOT_STOP === '1') return 'MFBOT_STOP=1 is set';
  if (cfg.killSwitchFile && fs.existsSync(cfg.killSwitchFile)) return 'the kill-switch file exists';
  return null;
}

/**
 * The raw secret text of a key: from the file named in the config, else from the environment variable it names.
 * Returns null when neither is set. Errors are fixed text: they never quote the file's content.
 */
export function readSecret(keyCfg, env = process.env) {
  if (keyCfg?.file) {
    try { return fs.readFileSync(keyCfg.file, 'utf8').trim(); } catch { throw new Error('the key file named in the config could not be read (its path and content are not shown)'); }
  }
  const v = keyCfg?.env ? env[keyCfg.env] : undefined;
  return v && v.trim() ? v.trim() : null;
}

/** An EVM private key in 0x-hex form, checked for shape only. */
export function evmKeyFrom(text) {
  const s = String(text ?? '').trim();
  const hex = s.startsWith('0x') ? s : `0x${s}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(hex)) throw new Error('the EVM key is not 32 bytes of hex (its content is not shown)');
  return hex;
}
