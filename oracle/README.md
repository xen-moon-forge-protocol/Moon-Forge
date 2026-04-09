# Moon Forge Oracle

The off-chain oracle that bridges XEN burns on EVM chains to XNT rewards on X1.

## Quick Start

```bash
# Install dependencies
npm install

# Copy and configure environment
cp .env.example .env
# Edit .env with your RPC URLs and keys

# Run single epoch (one-shot)
npm run dev

# Or run with cron scheduler (for VPS)
npm run listen
```

## How It Works

```
┌─────────────────┐    Events    ┌─────────────────┐    Merkle Root    ┌─────────────────┐
│  ETH + OP       │─────────────►│    ORACLE       │───────────────────►│      X1         │
│  (XEN Burns)    │              │  (This Script)  │                    │  (Reward Vault) │
└─────────────────┘              └─────────────────┘                    └─────────────────┘
                                         │
                                         ▼
                                 ┌─────────────────┐
                                 │  proofs.json    │
                                 │  (For Frontend) │
                                 └─────────────────┘
```

## Protocol Health Monitoring

During each epoch processing (`npm run epoch`), the oracle checks pool solvency before publishing:
- Validates that the **MoonForgeBase** vault holds at least **2× the epoch budget** in XNT.
- If underfunded, logs a critical warning and skips the epoch to protect the pool.
- Anyone can donate XNT to the pool via `MoonForgeBase.donate()` — the protocol is permissionless.

## Commands

| Command | Description |
|---------|-------------|
| `npm run dev` | Run single epoch processing |
| `npm run epoch` | Same as dev (explicit flag) |
| `npm run listen` | Start cron scheduler |
| `npm run build` | Compile TypeScript |
| `npm start` | Run compiled JS |

## Fairness Formula

```
Score = √(XEN burned) × TierMultiplier × NFTBonus
```

This ensures:
- **Anti-whale**: Square root compresses large burns
- **Commitment rewarded**: Higher tiers = higher multipliers
- **NFT holders**: Get +10% bonus

## Cron Deployment (VPS)

For production, run with PM2:

```bash
# Build first
npm run build

# Start with PM2
pm2 start dist/index.js --name moonforge-oracle -- --listen

# Check logs
pm2 logs moonforge-oracle
```

Or use system cron:

```bash
# Edit crontab
crontab -e

# Add daily run at midnight UTC
0 0 * * * cd /path/to/oracle && npm run epoch >> /var/log/moonforge.log 2>&1
```

## Environment Variables

See `.env.example` for all required configuration.

## Security

⚠️ **NEVER commit `.env` to git!**

The oracle private key has ORACLE_ROLE on MoonForgeBase and can publish new epochs.
