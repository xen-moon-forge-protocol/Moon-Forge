import type { PublicKey } from '@solana/web3.js';
import type { ProtocolSnapshot, X1Provider } from '../../lib/protocol';

/** Shared state handed to every game panel by GamesPage. */
export interface GameCtx {
    provider: X1Provider | null;
    owner: PublicKey | null;
    /** PlayerState account (null = no game wallet yet / not connected) */
    player: any | null;
    proto: ProtocolSnapshot | null;
    refresh: () => void;
}

export const ELEMENTS = ['Lunar', 'Cosmic', 'Solar', 'Void'] as const;
export const ELEMENT_ICONS = ['🌙', '✨', '☀️', '🕳️'];
