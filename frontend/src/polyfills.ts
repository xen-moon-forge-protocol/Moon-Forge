// Must be imported before anything that touches @solana/web3.js or @coral-xyz/anchor.
import { Buffer } from 'buffer';

(window as any).Buffer = (window as any).Buffer ?? Buffer;
(globalThis as any).Buffer = (globalThis as any).Buffer ?? Buffer;
