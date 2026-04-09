# Immutability Contract — Moon Forge Protocol

> **"Trust the code, not the person."**

This document defines exactly what is **permanently locked** and what **the community can adjust** after the protocol launches. Read this before contributing or forking.

---

## Why Immutability Matters

After the deployer calls `renounceOwnership()` on all contracts:

- **No admin key exists** — not the deployer, not anyone.
- **No upgrade mechanism** — contracts are not proxies.
- **No backdoor** — no `setOwner`, no `pause`, no `emergencyWithdraw` (removed by design).
- The protocol will run exactly as written, forever, until the last block.

This is a feature, not a limitation. It means you can verify every rule below on-chain and trust that nobody — including the original author — can ever change them.

---

## What Is LOCKED Forever

These parameters are set at deploy time and cannot be changed after `renounceOwnership()`.

### Economic Model

| Parameter | Value | Where |
|-----------|-------|--------|
| Tier 0 (Launchpad) duration | 5 days | `MoonForgeBase.sol` |
| Tier 0 multiplier | 1.0× | `MoonForgeBase.sol` |
| Tier 0 early-exit penalty | 0% | `MoonForgeBase.sol` |
| Tier 1 (Orbit) duration | 45 days | `MoonForgeBase.sol` |
| Tier 1 multiplier | 2.0× | `MoonForgeBase.sol` |
| Tier 1 early-exit penalty | 20% | `MoonForgeBase.sol` |
| Tier 2 (Moon Landing) duration | 180 days | `MoonForgeBase.sol` |
| Tier 2 multiplier | 3.0× | `MoonForgeBase.sol` |
| Tier 2 early-exit penalty | 50% | `MoonForgeBase.sol` |
| Fairness formula | `√(XEN × CWF) × Tier × NFT_Bonus` | `oracle/src/config.ts` |
| Square-root anti-whale compression | Hardcoded | Oracle |

### Fee Split (applied to early-exit penalties only — normal deposits have ZERO fee)

| Recipient | Share (with referrer) | Share (no referrer) | Where |
|-----------|----------------------|---------------------|-------|
| Reward Pool | 93.5% | 95.5% | `MoonForgeBase.sol` |
| Oracle Wallet | 1.0% | 1.0% | `MoonForgeBase.sol` |
| Referrer | 2.0% | 0% (stays in pool) | `MoonForgeBase.sol` |
| Dev Wallet (DevSplitter) | 2.0% | 2.0% | `MoonForgeBase.sol` |
| DevEscrow | 1.5% | 1.5% | `MoonForgeBase.sol` |

### DevSplitter Recipients

The wallet addresses that receive the 2% dev fee are set at `DevSplitter` deploy time and **cannot be changed** — the contract is immutable with no setter functions.

### NFT Artifact Supply & Boosts

| Tier | Name | Supply | Boost |
|------|------|--------|-------|
| 0 | Lunar Dust | 600 | +5% |
| 1 | Cosmic Shard | 300 | +10% |
| 2 | Solar Core | 90 | +20% |
| 3 | Void Anomaly | 10 | +50% |

Defined in `MoonArtifacts.sol`. Supply and boosts are locked at deploy time.

### NFT Metadata URI

Once `MoonArtifacts.initializePool()` is called, the `baseURI` is locked permanently. The 1,000 metadata files are pinned to IPFS and cannot be altered.

### Oracle Wallet

The address that signs Merkle roots is set immutably in `MoonForgeBase.sol` at deploy time. It cannot be rotated after `renounceOwnership()`.

> **Note:** Whoever operates the oracle VPS controls XNT distribution timing, but cannot steal funds. The Merkle proof system ensures users always claim exactly what the oracle allocates — no more, no less.

### XEN Contract Addresses

The XEN token address per chain is hardcoded in `MoonForgePortal.sol` per `chainId` and cannot be changed.

### Burn Validation Rules

- Minimum burn: enforced by contract
- `x1TargetAddress` must be a valid Base58 Solana address (32–44 chars, no `0x` prefix)
- Referrer cannot be the burner themselves

---

## What the COMMUNITY Can Adjust

These items are not immutable — the community can change them by running alternative infrastructure or deploying new portals.

### Frontend

| Item | How to Change |
|------|--------------|
| Website URL / hosting | Deploy to any static host (Vercel, Cloudflare, IPFS) |
| UI language / theme | Fork the frontend, build, deploy |
| GitHub URL (`GITHUB_URL` in `constants.ts`) | Update before building |
| Contract addresses in `constants.ts` | Must match deployed contracts |

### Oracle

| Item | How to Change |
|------|--------------|
| Epoch frequency | Change `EPOCH_CRON` in oracle `.env` |
| CWF epoch-0 seed values | Edit `oracle/src/config.ts` — oracle recalculates dynamically anyway |
| New chain support | Add chain config to oracle `.env` (e.g., `BASE_RPC_URL`) |
| Oracle operator | Anyone with the oracle private key can run the oracle bot |

> **Warning:** If the oracle stops running, no new epochs are published. Users already in missions can still `claimVested()` or `ejectPilot()` — funds are never locked. The protocol gracefully pauses until a new operator picks it up.

### Chain Rollout Timing

BSC (Day 13), Polygon/Avalanche (Day 26), Base/PulseChain (Day 39) activate when the oracle operator deploys the chain's portal and adds it to the oracle config. This is controlled by the oracle operator, not the contracts.

### New Portal Deployments

Anyone can deploy a new `MoonForgePortal.sol` on any EVM chain. It is a stateless burn contract — it reads the XEN contract, burns, and emits an event. The oracle can be configured to listen to any portal address.

---

## DevEscrow — The Community Incentive Lock

The 1.5% DevEscrow is a unique mechanism that rewards the development fee only if the protocol grows:

- Every 4 epochs, `DevEscrow.settleCycle()` is called (permissionless — anyone can call it).
- If this cycle's XNT volume ≥ last cycle's volume: the 1.5% is released to the DevSplitter.
- If not: the 1.5% is **returned to the reward pool** for that cycle.

This aligns developer incentives with protocol growth. If the protocol stagnates, developers earn nothing from the escrow.

---

## Upgradeability

There is **none**. The contracts are not upgradeable proxies. If a critical bug is found after `renounceOwnership()`:

1. The community forks the contracts with the fix applied.
2. A new protocol instance is deployed.
3. Users migrate voluntarily.

This is the only upgrade path. It is intentional — protocol immortality is the goal.

---

## Verifying Immutability On-Chain

After deploy and renounce, verify on any block explorer:

```
1. MoonForgeBase.owner()      → 0x0000...0000 (dead address)
2. MoonArtifacts.owner()      → 0x0000...0000
3. DevEscrow.owner()          → 0x0000...0000
4. DevSplitter (no owner)     → immutable by construction
5. MoonArtifacts.poolReady()  → true (URI locked)
```

If `owner()` returns anything other than the zero address, ownership has NOT been renounced yet.

---

*The forge is open. The rules are written. No one can change them.*
