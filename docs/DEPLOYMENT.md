# Moon Forge v6.0 - Deployment Guide

**Target Version:** 6.0 "The Scarcity Game"

---

## 1. EVM Deployment (Ethereum & Optimism)

**Contract:** `MoonForgePortal.sol`

### Ethereum Mainnet
- **XEN Token**: `0x06450dEe7FD2Fb8E39061434BAbCfc05599a6Fb8`
- **Deploy Command**: `npx hardhat run scripts/deploy_portal.ts --network mainnet`

### Optimism Mainnet
- **opXEN Token**: `0xeb585163debb1e637c6d617de3bef99347cd75c8`
- **Deploy Command**: `npx hardhat run scripts/deploy_portal.ts --network optimism`

---

## 2. X1 Deployment (Base & Artifacts)

**Network:** X1 Mainnet (SVM-based / EVM-compatible layer)

### Step A: Deploy MoonForgeBase 
- **Constructor Args**: `architectWallet`, `oracleWallet`
- **Command**: `npx hardhat run scripts/deploy_base.ts --network x1`
- **Save Address**: `BASE_ADDRESS`

### Step B: Deploy MoonArtifacts v6.0
- **Constructor Args**: `architectWallet`, `BASE_ADDRESS`, `oracleWallet`
- **Command**: `npx hardhat run scripts/deploy_artifacts.ts --network x1`
- **Save Address**: `ARTIFACTS_ADDRESS`

---

## 3. Initialization & Linking (CRITICAL)

These steps **MUST** be executed immediately after deployment to enable the Scarcity Game.

### 1. Initialize the Pool
- **Call**: `MoonArtifacts.initializePool()`
- **Effect**: Mints the 1,000 hard-capped NFTs to the contract's pool.
- **Gas**: High (simultaneous minting).

### 2. Link Contracts
- **Call**: `MoonForgeBase.setArtifactsContract(ARTIFACTS_ADDRESS)`
  - *Enables Lock/Release logic on the Vault.*
- **Call**: `MoonArtifacts.setVaultContract(BASE_ADDRESS)`
  - *Enables the Vault to call lockArtifact/restockArtifact.*

---

## 4. Oracle Configuration

Update `oracle/src/config.ts` with the new addresses:

```typescript
export const CONTRACTS = {
  portal_eth: "0x...",
  portal_op: "0x...",
  base_x1: "BASE_ADDRESS",
  artifacts_x1: "ARTIFACTS_ADDRESS"
};
```

---

## 5. Verification ("War Games")

Before public announcement:
1.  **Burn Test**: Burn 1000 XEN on Sepolia.
2.  **Epoch Test**: Wait for Oracle to publish root.
3.  **Claim Test**: Start mission. Verify NFT transferred to Vault (`lockArtifact`).
4.  **Eject Test**: Call `ejectPilot`. Verify NFT transferred back to Pool (`restockArtifact`).
