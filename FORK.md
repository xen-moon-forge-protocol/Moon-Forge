# 🌒 How to Fork & Re-deploy Moon Forge

Moon Forge is MIT-licensed and designed to be sovereign. If you want to launch a community fork with different parameters or a new contract, follow this guide to ensure a clean deployment.

## 🛠️ Deployment Checklist

If you are re-deploying the protocol, you **MUST** update these values in your codebase to avoid interacting with the original architect's vault.

### 1. Anchor Program (X1 SVM)
- **`Anchor.toml`**: Update the `[programs.mainnet]` address.
- **`programs/moon-forge-games/src/lib.rs`**: Update the `declare_id!("...")` macro.
- **Re-derive PDAs**: After deployment, use the `solana address` tool or the Anchor SDK to find your new Project State and Reward Vault addresses.

### 2. Frontend Constants
Open `frontend/src/lib/constants.ts` and update:
- **`PROTOCOL_CONTRACTS.BASE`**: Your new Anchor Program ID.
- **`PROTOCOL_STATE`**: Your new Project State PDA.
- **`REWARD_VAULT`**: Your new Reward Vault PDA.
- **`DONATION_ADDRESSES.devWallet`**: Change this to your community or developer wallet.
- **`GITHUB_URL`**: Update to your own fork's repository URL.

### 3. Oracle Config
Open `oracle/.env` (and `.env.example`) and update:
- **`X1_PROGRAM_ID`**: Your new Anchor Program ID.
- **Add your Portal Addresses**: Once you deploy your EVM portals, add their 0x addresses to the config.

### 4. Branding & Metadata
- **`branding/LAUNCH_KIT.md`**: Update the contract addresses in the templates.
- **`scripts/nft-metadata/generate-metadata.ts`**: Update the `EXTERNAL_URL_BASE` to your hosted docs.

## ⚖️ Economic Adjustments (Optional)
If your community wants different fees, you must change them **in the Rust code** before deployment:
- File: `programs/moon-forge-games/src/constants.rs` (or `lib.rs`)
- Look for: `FEE_BPS`, `TIER_MULTIPLIERS`, etc.

---
*The Forge is yours. Build the version your community needs.*
