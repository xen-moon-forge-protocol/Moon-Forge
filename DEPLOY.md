# Deployment Guide — Moon Forge Protocol

> **"Don't wait for the party. Forge it."**
>
> This guide covers two independent layers:
> - **EVM Layer (Burn Portals):** Anyone can deploy. No permission needed. No coordination with anyone.
> - **X1 SVM Layer (Rewards Vault):** Deployed once. Never needs redeployment regardless of how many portals exist.

---

## Architecture Overview — Why Community Deploys Work

```
[User Burns XEN]                [Oracle Reads Events]         [User Claims XNT]
    │                                    │                          │
    ▼                                    ▼                          ▼
MoonForgePortal.sol          oracle/src/oracle.ts          Anchor Program (X1 SVM)
(ANY EVM chain)         reads ALL configured portals       moon_forge_games
    │                                    │                          │
    │   emits MissionStarted()           │   publishes Merkle root  │
    └────────────────────────────────────┘──────────────────────────┘
```

**Key insight:** The EVM Portals and the X1 Anchor Program have ZERO on-chain connection to each other.
The Oracle (off-chain TypeScript service) bridges them by reading EVM events and publishing to X1.

This means:
- **Anyone can deploy a Portal on any EVM chain** with their own wallet, without asking anyone.
- **The X1 program never needs redeployment** — it works regardless of how many portals exist.
- **Adding a new chain** = deploy one contract + add one address to oracle config. That's it.

---

## PART 1 — X1 SVM Anchor Program (Deploy Once, Forever)

> **Who deploys this:** The original protocol creator (or any trusted first operator).
> **When:** Before any EVM portals are deployed. This is the foundation.

### Prerequisites (WSL2 on Windows / Linux / macOS)

```bash
# 1. Rust (check if already installed)
rustc --version || curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# 2. Solana CLI
sh -c "$(curl -sSfL https://release.anza.xyz/stable/install)"
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"
echo 'export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"' >> ~/.bashrc
source ~/.bashrc

# 3. Anchor CLI (0.30.1)
# NOTE: Anchor 0.29.0 does NOT compile on Rust 1.75+. Use 0.30.1.
cargo install --git https://github.com/coral-xyz/anchor avm --locked --force
avm install 0.30.1
avm use 0.30.1

# ── Troubleshooting: "binary already exists in destination" ──────────────────
# If avm fails to set a version (binary conflict from a previous partial install):
rm -f ~/.avm/bin/anchor ~/.cargo/bin/anchor   # clear stale binaries
avm install 0.30.1                             # reinstall clean
avm use 0.30.1                                 # activate
anchor --version                               # anchor-cli 0.30.1 ✅
# ──────────────────────────────────────────────────────────────────────────────

# 4. Verify
rustc --version   # 1.75+ (tested on 1.94)
solana --version  # 1.18+ (Agave/anza CLI is fine)
anchor --version  # 0.30.1
```

### Step 1 — Configure Solana CLI for X1

```bash
solana config set --url https://rpc.mainnet.x1.xyz
```

### Step 2 — Import your X1 wallet as deployer keypair

Your architect wallet (`7PuG8ELKXzvZqVLawFnmjDJqq4KEyRhssKQEq7aQM6Qd`) pays the deploy gas
and will be set as the permanent `architect` (receives 2% of all penalties).

Export your private key from X1 Wallet:
- X1 Wallet → Settings → Account → Export Private Key
- Save as: `~/.config/solana/deploy-wallet.json` (in this format: `[1,2,...,64]`)

```bash
solana config set --keypair ~/.config/solana/deploy-wallet.json
# Verify it shows your address:
solana address
# Should show: 7PuG8ELKXzvZqVLawFnmjDJqq4KEyRhssKQEq7aQM6Qd
```

> **Fund this wallet with ~3-5 XNT** for the program deployment rent.

### Step 3 — Build

```bash
# Navigate to project root (in WSL):
cd "/mnt/d/Repositórios GitHub/Moon-Forge"

# Build the Anchor program
anchor build
# This compiles Rust and generates:
#   target/deploy/moon_forge_games.so        (the program binary)
#   target/deploy/moon_forge_games-keypair.json (the program address)
#   target/idl/moon_forge_games.json         (the ABI/interface)
```

### Step 4 — Get the Program ID

```bash
solana address -k target/deploy/moon_forge_games-keypair.json
# Example output: AbcD1234XyZ...  ← COPY THIS (your X1 Program ID)
```

### Step 5 — Set the Program ID in code

Open `programs/moon-forge-games/src/lib.rs` line 78 and replace:
```rust
declare_id!("MoonForgeGames111111111111111111111111111111");
```
with:
```rust
declare_id!("YOUR_PROGRAM_ID_HERE");
```

Also update the root `Anchor.toml` line 2:
```toml
moon_forge_games = "YOUR_PROGRAM_ID_HERE"
```

### Step 6 — Rebuild with real ID, then Deploy

```bash
anchor build  # rebuild with real ID embedded
anchor deploy --provider.cluster https://rpc.mainnet.x1.xyz
# This uploads the compiled program to X1 mainnet.
# Cost: ~2-5 XNT for program rent storage.
```

### Step 7 — Initialize the Protocol (one-time setup)

After deploy, run the initialization to set immutable architect + oracle addresses:

```bash
node -e "
const anchor = require('@coral-xyz/anchor');
const { Keypair, Connection, PublicKey } = require('@solana/web3.js');
const fs = require('fs');
const path = require('path');

async function init() {
  const connection = new Connection('https://rpc.mainnet.x1.xyz', 'confirmed');
  const keypairFile = fs.readFileSync(path.join(process.env.HOME, '.config/solana/deploy-wallet.json'), 'utf8');
  const keypair = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(keypairFile)));

  const programId = new PublicKey('YOUR_PROGRAM_ID_HERE');
  const architect = new PublicKey('7PuG8ELKXzvZqVLawFnmjDJqq4KEyRhssKQEq7aQM6Qd');
  const oracle    = new PublicKey('J5CU45Didfq7ng9JHXyxYqN7TwAGjMgEyhUcrV7Aixba');

  const idl = JSON.parse(fs.readFileSync('target/idl/moon_forge_games.json', 'utf8'));
  const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(keypair), {});
  const program = new anchor.Program(idl, programId, provider);

  const tx = await program.methods.initializeProtocol(architect, oracle).rpc();
  console.log('✅ Protocol initialized! TX:', tx);
}
init().catch(console.error);
"
```

### Step 8 — Update oracle/.env with the Program ID

Open `oracle/.env` and replace:
```bash
X1_PROGRAM_ID=PREENCHER_APOS_ANCHOR_DEPLOY
```
with your real program ID.

### Step 9 — Calculate the oracle discriminator

```bash
node -e "
const c = require('crypto');
const disc = Array.from(c.createHash('sha256').update('global:update_merkle_root').digest().slice(0,8));
console.log('Discriminator:', JSON.stringify(disc));
"
```

Open `oracle/src/services/x1Publisher.ts` and replace the `[0,0,0,0,0,0,0,0]` placeholder with the real array.

---

## PART 2 — EVM Portal Deployment (Per Chain — Anyone Can Do This)

> **Who deploys this:** The original team for Day 0 chains. The COMMUNITY for any additional chains.
> **Wallet:** Each deployer uses their OWN fresh EVM wallet. It has zero lasting power after deploy.
> **Connection to X1:** NONE. The Oracle connects them. The Portal just burns XEN and emits events.

### What a community deployer needs

1. **Git clone** of this repo: `git clone https://github.com/xen-moon-forge-protocol/Moon-Forge.git`
2. **Node.js 18+** and `npm install` in the project root
3. **Their own fresh EVM wallet** with gas money on the target chain
4. **The XEN token address** for their chain (all known chains are hardcoded in `deploy_portal.ts`)

### Step 1 — Configure .env (minimal, just for portal deploy)

Create/edit the root `.env`:
```bash
# The only thing a community deployer needs:
PRIVATE_KEY=0x_your_fresh_evm_private_key_here

# (RPC endpoints already have public fallbacks — you can override if needed)
ETH_RPC=https://eth.llamarpc.com
OP_RPC=https://optimism.llamarpc.com
BSC_RPC=https://bsc-dataseed.binance.org
POLYGON_RPC=https://polygon.llamarpc.com
AVAX_RPC=https://api.avax.network/ext/bc/C/rpc
BASE_RPC=https://mainnet.base.org
PULSE_RPC=https://rpc.pulsechain.com
```

> **There are NO other fields needed for portal deploy.** No architect wallet. No oracle address.
> The Portal is fully autonomous — it burns XEN and emits events. That's it.

### Step 2 — Deploy (one command per chain)

```bash
# Day 0 chains (original team):
npx hardhat run scripts/deploy_portal.ts --network optimism
npx hardhat run scripts/deploy_portal.ts --network bsc
npx hardhat run scripts/deploy_portal.ts --network polygon

# Day 0 — Ethereum (optional, higher gas):
npx hardhat run scripts/deploy_portal.ts --network mainnet

# Community additions (anyone, anytime):
npx hardhat run scripts/deploy_portal.ts --network avalanche
npx hardhat run scripts/deploy_portal.ts --network base
npx hardhat run scripts/deploy_portal.ts --network pulsechain

# Brand new chain (not in the list above):
XEN_ADDRESS=0x_xen_on_new_chain npx hardhat run scripts/deploy_portal.ts --network newchain
```

The script outputs the portal address. **Copy it — you need it for Step 3.**

### Step 3 — Report the portal address

After deploying on a new chain, do ONE of the following so the oracle starts reading it:

**Option A — If you run your own oracle:**
Add to `oracle/.env`:
```bash
NEWCHAIN_RPC_URL=https://rpc.newchain.example
NEWCHAIN_PORTAL_ADDRESS=0x_your_portal_address
```
Then add the chain config in `oracle/src/config.ts` (copy an existing chain block).

**Option B — If you don't run the oracle:**
Open an issue on GitHub with:
```
Chain: [chain name + chainId]
Portal address: 0x...
RPC: [a public RPC endpoint]
XEN address: 0x...
```
The oracle operator adds it to their config. **No code changes. No redeployment of anything.**

### Gas needed per chain

| Chain | Estimated gas cost | Suggested amount to fund wallet |
|-------|-------------------|--------------------------------|
| Ethereum | ~0.012-0.025 ETH | 0.03 ETH |
| Optimism | ~0.002 ETH | 0.005 ETH |
| BSC | ~0.003-0.008 BNB | 0.01 BNB |
| Polygon | ~0.05-0.1 MATIC | 0.5 MATIC |
| Avalanche | ~0.015-0.03 AVAX | 0.05 AVAX |
| Base | ~0.001 ETH | 0.003 ETH |
| PulseChain | negligible | 1000 PLS |

---

## PART 3 — Oracle Setup (Who Runs This?)

The oracle is the bridge between EVM events and the X1 Anchor program. Someone needs to run it.

**The protocol creator runs it initially.** The community can also run additional oracle instances — the Anchor program accepts updates from one specific oracle address (`ProtocolState.oracle`), so parallel oracles would need coordination.

### Setup

```bash
cd oracle
npm install
# oracle/.env is already configured (ORACLE_PRIVATE_KEY, X1_PROGRAM_ID, etc.)
# Fill in portal addresses after EVM deploys

npm run start  # starts the oracle service
```

The oracle runs a cron job every epoch (default: every Sunday at 00:00 UTC). It:
1. Reads `MissionStarted` events from all configured portals
2. Calculates CWF-weighted scores
3. Generates Merkle tree
4. Publishes root to X1 Anchor program
5. Saves `proofs.json` to `frontend/public/` for user claims

---

## PART 4 — GitHub (Anonymous Account + Pages)

### Step 1 — Create an anonymous GitHub account

1. Open a private browser window
2. Go to https://github.com/join
3. Create account with a **new anonymous email** (ProtonMail, Tutanota, or SimpleLogin)
4. Username suggestion: `moon-forge-dao` or `moonforgedao` (or any anon name)
5. **Never access this account from your personal browser/IP without a VPN**

### Step 2 — Create the repository

1. Create repo named **`Moon-Forge`** (this must match `base: '/Moon-Forge/'` in vite.config.ts)
2. Set to **Public** — the community needs to read and fork the code
3. No template, no README (you'll push the existing code)

### Step 3 — Push the code

```bash
# In WSL, from project root:
cd "/mnt/d/Repositórios GitHub/Moon-Forge"

# If git not initialized:
git init
git add .
git commit -m "Moon Forge Protocol — initial release"

# Connect to your anonymous GitHub account:
git remote add origin https://github.com/YOUR_ANON_USERNAME/Moon-Forge.git
git branch -M main
git push -u origin main
```

> **Before pushing:** make sure `oracle/.env` is in .gitignore (it is ✅). Your oracle keypair and private keys must NEVER reach GitHub.

### Step 4 — Enable GitHub Pages

1. Go to your repo → **Settings → Pages**
2. Source: **GitHub Actions** (not "Deploy from branch")
3. The workflow at `.github/workflows/deploy-frontend.yml` auto-deploys on every push to `main`
4. First deploy takes ~2 minutes. URL will be: `https://YOUR_ANON_USERNAME.github.io/Moon-Forge/`

### Step 5 — Update constants.ts with your Pages URL

After the first deploy succeeds, update [frontend/src/lib/constants.ts](frontend/src/lib/constants.ts):
```typescript
export const GITHUB_URL = 'https://github.com/YOUR_ANON_USERNAME/Moon-Forge';
```
Then push again — the workflow redeploys automatically.

---

## PART 5 — Frontend Local Build (Pre-Push Verification)

```bash
cd frontend
npm install

# After filling in all addresses in constants.ts:
npm run build     # builds to frontend/dist/
npm run preview   # preview locally before pushing

# If all good, push to GitHub → Pages auto-deploys via GitHub Actions
```

---

## Summary — Who Does What

| Action | Who | Wallet Needed | Power After |
|--------|-----|---------------|-------------|
| Deploy X1 Anchor program | Original team | Architect X1 wallet (needs XNT) | Sets immutable architect + oracle |
| Deploy EVM Portal (OP, BSC, Polygon) | Original team | Fresh EVM wallet (needs gas) | None — no owner |
| Deploy EVM Portal (any other chain) | **Anyone** | Their own fresh wallet | None — no owner |
| Run oracle | Original team initially; community can fork | Oracle X1 keypair | Only publishes Merkle roots |
| Run frontend | Anyone (static files) | None | None |
| Claim XNT | Users | X1 Wallet (SVM) | Their own vested balance |

---

## Full FAQ for Community Deployers

**Q: Can I use my main personal wallet to deploy?**
A: You can, but it creates an on-chain link. We recommend a fresh wallet funded by a direct CEX withdrawal.

**Q: If I deploy a Portal, do I receive any fees?**
A: No. The Portal is completely feeless — it just burns XEN. No owner. No revenue. It's community infrastructure.

**Q: Does my Portal deployment need to be approved?**
A: No. It's fully permissionless. Deploy and report the address so the oracle picks it up.

**Q: Can I deploy on a chain that's not in the list?**
A: Yes. Use `XEN_ADDRESS=0x... npx hardhat run scripts/deploy_portal.ts --network yourchain`. You need to add `yourchain` to `hardhat.config.ts` first.

**Q: What if XEN doesn't exist on my chain?**
A: The Portal requires a XEN token at the address you provide. If XEN hasn't been deployed on that chain, the Portal won't work. Check xen.network for official chain support.

**Q: Do I need the X1 Anchor program address to deploy a Portal?**
A: No. The Portal has zero knowledge of X1. It just burns XEN. The oracle handles the rest.

**Q: Can I run my own oracle?**
A: Yes, but the Anchor program only accepts Merkle roots from the registered oracle address. To add a second oracle, the original oracle would need to call `update_merkle_root` with a co-signed root. This is a governance decision for future protocol evolution.

---

---

## PART 5 — After First Deploy: What Comes Next

Once the X1 Anchor program and the first EVM portals (OP + BSC + Polygon) are live, this is the exact sequence:

### Immediate post-deploy checklist

```
[ ] anchor deploy succeeded → copy program ID (Base58)
[ ] initialize_protocol() ran → check the TX on X1 explorer
[ ] oracle/.env updated: X1_PROGRAM_ID=<program-id>
[ ] oracle discriminator calculated → x1Publisher.ts updated
[ ] EVM portals deployed → copy 3 addresses
[ ] oracle/.env updated: OP_PORTAL_ADDRESS=, BSC_PORTAL_ADDRESS=, POLYGON_PORTAL_ADDRESS=
[ ] frontend/src/lib/constants.ts updated: PORTAL_OP, PORTAL_BSC, PORTAL_POLYGON, X1_PROGRAM_ID
[ ] LAUNCH_DATE in constants.ts set to real UTC timestamp
[ ] oracle started: cd oracle && npm run start
[ ] frontend built and uploaded: cd frontend && npm run build
```

### Adding new chains later (community or team)

No redeploy of anything needed. For each new chain:

1. Deploy a portal: `npx hardhat run scripts/deploy_portal.ts --network <chain>`
2. Add two lines to `oracle/.env`:
   ```bash
   NEWCHAIN_RPC_URL=https://rpc.example
   NEWCHAIN_PORTAL_ADDRESS=0x...
   ```
3. Add one chain block to `oracle/src/config.ts` (copy an existing block, update chainId/name/rpc/portal).
4. Restart oracle. The next epoch automatically includes the new chain.

That's it. Zero on-chain changes. Zero redeployment.

---

## PART 6 — NFT Artifacts: Phase 2 (No Cost for V1 Launch)

> **Short answer:** NFTs do nothing at launch. Zero cost. Zero action needed.

### V1 State (Current)

The Anchor program already has NFT infrastructure built in:
- `VestingAccount` stores `nft_boost_bps` field
- The field is always `0` in V1 (no on-chain verification yet)
- Oracle always sets boost to 0 when building Merkle leaves
- The frontend shows NFT tiers as "Phase 2" labels

This means the protocol launches fully functional without NFTs. Burns, claims, missions, penalties — all work.

### Phase 2 — What's actually needed

| Task | Complexity | Cost |
|------|-----------|------|
| Deploy MoonArtifacts Anchor program on X1 | Medium — same process as main program | ~2-3 XNT rent |
| Mint NFT collection (Metaplex / Compressed NFTs) | Medium | ~1-5 XNT depending on supply |
| Upload artwork + metadata to IPFS/Arweave | Simple | ~$5-20 depending on size |
| Update oracle to read NFT holders on-chain | Medium — add one read per epoch | No on-chain cost |
| Update oracle Merkle leaf to include boost | Simple — change one constant | No cost |

**None of this is blocking for V1.** You can launch today, get users burning XEN, and add NFTs in a separate Phase 2 sprint when ready.

### Phase 2 trigger

When you're ready for Phase 2:
1. Deploy `MoonArtifacts` Anchor program
2. Update oracle `config.ts`: set `COMMANDER_PROGRAM_ID` to real address
3. Oracle automatically starts reading holders and applying boosts next epoch
4. Frontend automatically shows NFT boost in the ROI calculator (already coded)

Zero breaking changes. Zero user migration. Existing missions continue unaffected.

---

*The forge is autonomous. Expand it.*
