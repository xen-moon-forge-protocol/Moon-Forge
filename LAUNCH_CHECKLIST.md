# Moon Forge — Launch Checklist

> Work through this top to bottom. Each step builds on the previous one.
> Steps marked **[YOU]** require your action. Steps marked **[AUTO]** happen automatically.

---

## PHASE 1 — Build the Anchor Program (WSL)

```
[ ] [YOU]  avm install 0.30.1
[ ] [YOU]  avm use 0.30.1
[ ] [YOU]  anchor --version  → should show: anchor-cli 0.30.1

[ ] [YOU]  cd "/mnt/d/Repositórios GitHub/Moon-Forge"
[ ] [YOU]  solana config set --url https://rpc.mainnet.x1.xyz
[ ] [YOU]  anchor build
           → generates: target/deploy/moon_forge_games.so
           → generates: target/deploy/moon_forge_games-keypair.json
           → generates: target/idl/moon_forge_games.json

[ ] [YOU]  solana address -k target/deploy/moon_forge_games-keypair.json
           → COPY THE OUTPUT (your X1 Program ID, Base58)
```

---

## PHASE 2 — Set Program ID in Code

```
[ ] [YOU]  Open: programs/moon-forge-games/src/lib.rs
           Find: declare_id!("MoonForgeGames111111111111111111111111111111");
           Replace with: declare_id!("YOUR_PROGRAM_ID_HERE");

[ ] [YOU]  Open: Anchor.toml (root)
           Find: moon_forge_games = "MoonForgeGames111111111111111111111111111"
           Replace with: moon_forge_games = "YOUR_PROGRAM_ID_HERE"

[ ] [YOU]  anchor build   (rebuild with real ID embedded)
```

---

## PHASE 3 — Deploy to X1 Mainnet

```
[ ] [YOU]  Export private key from X1 Wallet:
           X1 Wallet → Settings → Account → Export Private Key
           Save as: ~/.config/solana/deploy-wallet.json
           Format: [1,2,...,64]  (array of 64 integers)

[ ] [YOU]  solana config set --keypair ~/.config/solana/deploy-wallet.json
[ ] [YOU]  solana address   → must show: 7PuG8ELKXzvZqVLawFnmjDJqq4KEyRhssKQEq7aQM6Qd

[ ] [YOU]  Fund architect wallet with 3-5 XNT for rent
           (buy XNT on exchange, withdraw to 7PuG8...M6Qd on X1 network)

[ ] [YOU]  anchor deploy --provider.cluster https://rpc.mainnet.x1.xyz
           → COPY the program ID from output (same as Phase 1)
```

---

## PHASE 4 — Initialize Protocol (one-time, irreversible)

```
[ ] [YOU]  Run initialize_protocol() — see DEPLOY.md Part 1 Step 7 for full script
           architect = 7PuG8ELKXzvZqVLawFnmjDJqq4KEyRhssKQEq7aQM6Qd
           oracle    = J5CU45Didfq7ng9JHXyxYqN7TwAGjMgEyhUcrV7Aixba
           → COPY the TX hash for your records
```

---

## PHASE 5 — Deploy EVM Portals

```
[ ] [YOU]  Fund your anonymous EVM wallet with gas:
           - Optimism:   ~0.005 ETH
           - BSC:        ~0.01 BNB
           - Polygon:    ~0.5 MATIC

[ ] [YOU]  npx hardhat run scripts/deploy_portal.ts --network optimism
           → COPY portal address: 0x...  (PORTAL_OP)

[ ] [YOU]  npx hardhat run scripts/deploy_portal.ts --network bsc
           → COPY portal address: 0x...  (PORTAL_BSC)

[ ] [YOU]  npx hardhat run scripts/deploy_portal.ts --network polygon
           → COPY portal address: 0x...  (PORTAL_POLYGON)
```

---

## PHASE 6 — Fill In All Addresses

After Phases 3-5 you will have:
- X1 Program ID (Base58)
- PORTAL_OP (0x...)
- PORTAL_BSC (0x...)
- PORTAL_POLYGON (0x...)

```
[ ] [YOU]  Edit oracle/.env:
           X1_PROGRAM_ID=<Base58 program ID>
           OP_PORTAL_ADDRESS=<0x...>
           BSC_PORTAL_ADDRESS=<0x...>
           POLYGON_PORTAL_ADDRESS=<0x...>
           (uncomment BSC_RPC_URL and POLYGON_RPC_URL lines)

[ ] [YOU]  Edit frontend/src/lib/constants.ts — PROTOCOL_CONTRACTS:
           BASE: '<Base58 program ID>'

[ ] [YOU]  Edit frontend/src/lib/constants.ts — chain portal addresses:
           Find CHAINS array → set portalAddress for optimism, bsc, polygon

[ ] [YOU]  Set LAUNCH_DATE in constants.ts to real launch timestamp
           (current value: 2026-04-02T00:00:00Z — update if needed)
```

---

## PHASE 7 — Start the Oracle

```
[ ] [YOU]  cd oracle
[ ] [YOU]  npm install
[ ] [YOU]  npm run dev    (test first — runs one epoch immediately)
           → should log: "✅ PUBLISH SUCCESSFUL!" with a TX hash

[ ] [YOU]  npm run start  (production — cron every Sunday 00:00 UTC)
```

---

## PHASE 8 — Launch on GitHub (Anonymous)

```
[ ] [YOU]  Create anonymous GitHub account (new email, private browser, VPN)
           Suggested username: moon-forge-dao

[ ] [YOU]  Create repo named: Moon-Forge (Public)

[ ] [YOU]  In WSL:
           cd "/mnt/d/Repositórios GitHub/Moon-Forge"
           git init
           git add .
           git commit -m "Moon Forge Protocol — initial release"
           git remote add origin https://github.com/YOUR_USERNAME/Moon-Forge.git
           git branch -M main
           git push -u origin main

[ ] [AUTO] GitHub Actions builds and deploys frontend to Pages (~2 min)

[ ] [YOU]  Repo → Settings → Pages → Source: GitHub Actions  (enable Pages)

[ ] [YOU]  Site live at: https://YOUR_USERNAME.github.io/Moon-Forge/

[ ] [YOU]  Update GITHUB_URL in frontend/src/lib/constants.ts with real URL
[ ] [YOU]  git add . && git commit -m "Update GitHub URL" && git push
[ ] [AUTO] Pages redeploys automatically
```

---

## PHASE 9 — Verify Everything

```
[ ] [YOU]  Visit the live site — all pages load?
[ ] [YOU]  Connect X1 Wallet → The Forge page works?
[ ] [YOU]  Connect MetaMask on Optimism → burn 1 XEN (small test burn)
[ ] [YOU]  Wait for next oracle epoch (or run manually: npm run epoch)
[ ] [YOU]  X1 explorer: oracle TX appears with correct Merkle root?
[ ] [YOU]  Claim XNT on site → works?

[ ] Share repo URL in XEN/X1 communities
[ ] Open a GitHub Discussion for community portal deployments
```

---

## PHASE 10 (Future) — NFT Artifacts

```
[ ] Community deploys MoonArtifacts Anchor program (see ArtifactsPage for instructions)
[ ] Community uploads artwork + metadata to Arweave
[ ] Oracle automatically reads NFT holders next epoch
[ ] Phase 2 active — zero code changes to core protocol
```

---

*"Don't wait for the party. Forge it."*
