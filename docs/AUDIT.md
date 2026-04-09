# 🔍 Moon Forge - Complete Rationale Audit

This document verifies that ALL decisions from the planning conversation have been captured.

---

## ✅ CONFIRMED DECISIONS

### 1. Problem Definition
- [x] XEN hyperinflation across EVM chains
- [x] Moon Party promised but never delivered
- [x] Community needs trustless alternative
- [x] opXEN already deflation-ready, XEN (ETH) has most liquidity

### 2. Solution Architecture
- [x] Cross-chain burn-to-earn (EVM → SVM)
- [x] NO bridge of assets (too risky for hack)
- [x] Oracle-based proof system instead
- [x] Starting with ETH + OP, expandable to other chains

### 3. Economic Model
- [x] **Epoch Quota System** (insolvency-proof)
- [x] **Square Root Formula** (anti-whale: √amount)
- [x] **Dynamic Premiums** (burn always better than swap + time)
- [x] **Vesting Multipliers** (longer lock = higher reward)

### 4. Vesting Tiers (Space Theme)
- [x] Tier 0: **Launchpad** - 5 days, 1.1x, 0% penalty
- [x] Tier 1: **Orbit** - 45 days, 1.5x, 20% penalty
- [x] Tier 2: **Moon Landing** - 180 days, 3.0x, 50% penalty

### 5. Penalty Split
- [x] 95% → Reward Pool (community)
- [x] 4% → Oracle Wallet (Auto-Fuel for gas)
- [x] 1% → Architect Wallet (creator sustainability)

### 6. NFT Funding (MoonCommander)
- [x] 3,333 total supply
- [x] Tiered pricing: 25/50/100 XNT (creates FOMO)
- [x] +10% permanent bonus for holders
- [x] Funds split: 95% pool, 5% architect

### 7. Branding
- [x] Name: **Moon Forge**
- [x] Slogan: "Don't wait for the party. Forge it."
- [x] Space/Moon theme throughout
- [x] Dark aesthetic

### 8. Developer Strategy
- [x] **Zero Dev Fees** on user deposits/claims
- [x] Revenue only from penalties (1%) and NFT (5%)
- [x] Fully anonymous (OpSec plan)
- [x] Open source / forkable

### 9. Sustainability
- [x] Auto-Fuel mechanism (4% of penalties)
- [x] Community donation for server (~$5-10/month)
- [x] VPS prepaid 2 years option
- [x] Anyone can run oracle if original dies

### 10. Cross-Chain Mapping
- [x] EVM address (0x...) maps to X1 address (Base58)
- [x] User provides X1 address in burn transaction
- [x] Oracle reads event and maps correctly

### 11. Frontend Requirements
- [x] 100% English
- [x] React + Vite
- [x] GitHub Pages hosting (no logs)
- [x] Dual wallet: MetaMask (EVM) + X1 Wallet (SVM)
- [x] System Status panel (oracle gas, server health)
- [x] Tier calculator showing burn premium vs swap

### 12. Forkability ("Take Control" Philosophy)
- [x] Multiple frontends can use same contract
- [x] Liquidity = gravity (keeps everyone on main contract)
- [x] GitHub public repo with MIT license
- [x] Anyone can create their own "skin"

### 13. Immutability
- [x] Core contracts ownerless after deploy
- [x] No admin keys
- [x] User balances on-chain (not on website)
- [x] Protocol survives if website dies

### 14. Trade vs Burn Choice Preserved
- [x] Users can still swap XEN on DEX (immediate liquidity)
- [x] Burn gives premium (20-300% based on tier)
- [x] Both options visible in UI

---

## 📊 FINAL NUMBERS SUMMARY

| Parameter | Value |
|-----------|-------|
| Architect Fee | 1% of penalties |
| Oracle Auto-Fuel | 4% of penalties |
| Community Pool | 95% of penalties |
| NFT Supply | 3,333 |
| NFT Price Tier 1 | 25 XNT (IDs 0-999) |
| NFT Price Tier 2 | 50 XNT (IDs 1000-2999) |
| NFT Price Tier 3 | 100 XNT (IDs 3000-3332) |
| NFT Holder Bonus | +10% on all burns |
| Launchpad Duration | 5 days |
| Orbit Duration | 45 days |
| Moon Landing Duration | 180 days |
| Launchpad Multiplier | 1.1x |
| Orbit Multiplier | 1.5x |
| Moon Landing Multiplier | 3.0x |
| Orbit Exit Penalty | 20% |
| Moon Landing Exit Penalty | 50% |

---

## 🎯 NEXT STEPS

1. **Approve this plan** → Review implementation_plan.md
2. **Generate contracts** → Solidity code for all 3 contracts ✅
3. **Build oracle** → Node.js script
4. **Build frontend** → React + Vite app
5. **Deploy testnet** → Sepolia + X1 Testnet
6. **War games** → 50+ test burns
7. **Deploy mainnet** → Launch!

---

*Audit completed: 2026-01-22*
