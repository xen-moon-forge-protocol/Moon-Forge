# Operators Guide — Moon Forge Protocol

> **No permission needed. No coordination required. Just run it.**

The X1 Anchor program is already deployed and initialized on X1 mainnet.
Everything else — EVM portals, oracle, frontend — can be run by anyone.

---

## The Three Operator Roles

| Role | What They Do | What They Earn |
|------|-------------|----------------|
| **Portal Deployer** | Deploys MoonForgePortal.sol on an EVM chain | Nothing (one-time setup) |
| **Oracle Operator** | Runs the oracle service to process epochs | **1% of all early-exit penalties** (auto-paid to oracle wallet) |
| **Frontend Host** | Hosts the React app on any static host | Nothing (public good) |

These roles are completely independent. You can do one, two, or all three.

---

## What Is Already Deployed (No Action Needed)

| Item | Address | Chain |
|------|---------|-------|
| Anchor Program | `57UE1U1t23ztg2noLp8pcpGW1B1Xw25rLH6ra9Mchea9` | X1 mainnet |
| Reward Vault | `CScsBfpj63Mppem9Bmddmfi87bkcAfeLevdSauYMDsHR` | X1 mainnet |
| Protocol State | `5dLsHmw6VvsbPhuHte6E2QJjm87oAWC1VxN43ngYfSGn` | X1 mainnet |
| Dev Escrow | `8hAFXd1PhioLnR9VhsuCSC6m2Yi3yigpfLccuMFk6G7x` | X1 mainnet |

---

## 1. Deploy an EVM Portal

See [DEPLOY.md](DEPLOY.md) for the full guide. The short version:

```bash
# 1. Clone the repo
git clone https://github.com/moon-forge-protocol/Moon-Forge
cd Moon-Forge

# 2. Install dependencies
npm install

# 3. Create .env
cp .env.example .env
# Edit .env: set PRIVATE_KEY to your deployer wallet private key

# 4. Deploy on your chosen chain
npx hardhat run scripts/deploy_portal.ts --network optimism
# or: mainnet, bsc, polygon, avalanche, base, pulsechain

# 5. Note the deployed address in output — add it to the oracle config
```

**Cheapest chains to start:** Optimism (~$5), BSC (~$2), Polygon (~$1)

---

## 2. Run the Oracle

The oracle reads EVM burn events and publishes Merkle roots to the X1 Anchor program.
**Oracle operators earn 1% of all early-exit penalties.** You need to use a fresh oracle wallet to receive this.

### Requirements
- Node.js 20+
- A server/VPS (or your local machine — runs once per epoch)
- ~0.1 XNT for oracle transaction fees on X1

### Setup

```bash
# 1. Go to oracle directory
cd oracle

# 2. Install dependencies
npm install

# 3. Create oracle config
cp .env.example .env
```

**Fill in `.env`:**
```env
# Your oracle X1 wallet (Base58) — THIS wallet earns the 1% fee
# Generate one: solana-keygen new
ORACLE_PRIVATE_KEY=[1,2,3,...,64]   # byte array from solana-keygen

# X1 program (already deployed — do not change)
X1_PROGRAM_ID=57UE1U1t23ztg2noLp8pcpGW1B1Xw25rLH6ra9Mchea9
X1_RPC_URL=https://rpc.mainnet.x1.xyz

# EVM RPCs (use any public or private RPC)
ETH_RPC_URL=https://cloudflare-eth.com
OP_RPC_URL=https://mainnet.optimism.io
# BSC_RPC_URL=https://bsc-dataseed.binance.org
# POLYGON_RPC_URL=https://polygon-rpc.com

# EVM Portal addresses (fill after portal deployments)
OP_PORTAL_ADDRESS=0x...   # from deploy step above
# ETH_PORTAL_ADDRESS=0x...
# BSC_PORTAL_ADDRESS=0x...
```

**Generate oracle wallet:**
```bash
# Install Solana CLI if needed
solana-keygen new -o oracle-wallet.json --no-bip39-passphrase
solana address -k oracle-wallet.json
# Copy the byte array from oracle-wallet.json → ORACLE_PRIVATE_KEY in .env
```

**Run:**
```bash
npm start
# Processes current epoch, generates Merkle proofs, publishes to X1
# Run once per epoch (weekly) via cron or manually
```

**Cron example (runs every Sunday at midnight UTC):**
```bash
0 0 * * 0 cd /path/to/Moon-Forge/oracle && npm start >> oracle.log 2>&1
```

> ⚠️ **Important:** The oracle wallet in `.env` is YOURS — it earns fees. The dev wallet (`7PuG8...`) is hardcoded in the X1 program and receives 2% of penalties regardless of who runs the oracle. Your oracle wallet earns the 1% oracle share separately.

---

## 3. Host the Frontend

The frontend is a static React app. Works on GitHub Pages, Vercel, Netlify, or any web server.

### GitHub Pages (Free)

```bash
# 1. Fork the repo to your GitHub account

# 2. Go to repo Settings → Pages → Source: GitHub Actions

# 3. The workflow at .github/workflows/deploy-frontend.yml handles the rest
#    It builds and deploys automatically on every push to main
```

### Manual Build

```bash
cd frontend
npm install
npm run build
# Upload /frontend/dist to any static host
```

### Update Frontend Config

Before hosting, update `frontend/src/lib/constants.ts`:
```typescript
// Update with your portal addresses after deployment
// In CHAINS config, set portalAddress for each chain you deployed:
optimism: {
    portalAddress: '0xYOUR_DEPLOYED_PORTAL_ADDRESS',
    ...
}
```

Rebuild and redeploy after updating portal addresses.

---

## 4. Add New Portal to Oracle

After deploying a portal on a new chain:

1. Add the portal address to `oracle/.env`
2. Uncomment the chain's RPC URL in `.env`
3. Restart the oracle

The oracle picks up all configured portals automatically. No code changes needed.

---

## Hardware Requirements

| Role | Minimum | Notes |
|------|---------|-------|
| Portal Deploy | Any PC | One-time operation |
| Oracle | 512MB RAM, any OS | Runs once/week — can use free tier VPS |
| Frontend | Static hosting | GitHub Pages is free |

---

## Getting Help

- Read the [WHITEPAPER](docs/WHITEPAPER.md) for economic model details
- Read [DEPLOY.md](DEPLOY.md) for EVM portal deployment specifics
- Open a GitHub Issue for bugs or questions

---

*No permission needed. No registration. No KYC. Run it. The protocol is yours.*
