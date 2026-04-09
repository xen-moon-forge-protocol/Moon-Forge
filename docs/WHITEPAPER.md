# 🌑 MOON FORGE PROTOCOL
## The Forge That Should Have Been.

**Version:** 12.0 (CWF Fair Value Engine)
**Network:** X1 Blockchain + Multi-Chain Burn Layer
**Status:** Decentralized, Immutable, Community-Built.

---

## ⚠️ Critical Disclaimer

> [!CAUTION]
> - **Unofficial:** Moon Forge is a community protocol, NOT affiliated with the X1 team.
> - **Permanent:** Burning XEN is irreversible.
> - **No Guarantees:** Rewards depend on pool balance and total epoch participation.
> - **Risk:** Use only what you can afford to lose.

---

## 1. What is Moon Forge?

Moon Forge allows you to convert XEN tokens from EVM chains (Ethereum, Optimism, BSC, Polygon, Avalanche) into **XNT rewards** on X1 Blockchain via a Proof-of-Burn mechanism.

**The Loop:**
```
Burn XEN (EVM) → Wait for Epoch (Oracle) → Initialize Mission (X1) → Vest → Claim XNT
```

---

## 2. Fair Value Engine — CWF v2 Formula (v12.0)

Different chains have fundamentally different XEN token economics. 1 ETH-XEN represents far more economic effort than 1 Polygon-mXEN. Moon Forge uses a **Chain Weight Factor (CWF)** that captures three independent economic signals, ensuring your score reflects your true economic sacrifice — not just raw token count.

> [!IMPORTANT]
> **Full Formula:**
> ```
> Forge Score = √(XEN_burned × CWF) × Tier_Multiplier × NFT_Bonus × Streak_Multiplier
> ```
> where `CWF = normalize( ISF × GCF × PF )` and ETH is always the anchor at 1.0.

### The Three CWF Components

```
ISF (Inflation Scarcity Factor)  = AMP_max / AMP_current
GCF (Gas Cost Factor)            = gas_ETH / gas_chain
PF  (Price Factor)               = (price_chain_EMA7 / price_ETH_EMA7) ^ 0.33

CWF = normalize( ISF × GCF × PF )  →  ETH always = 1.0
```

**ISF — Inflation Scarcity (Primary):**
XEN's built-in AMP starts at 3,000 and drops by 1 every day — time-based only, not affected by burns. Lower AMP = fewer new XEN minted per day = higher scarcity = higher ISF.
- Optimism XEN reached AMP≈1 (near-deflationary) → ISF≈3000, close to ETH
- Polygon still has high AMP and massive supply → much lower ISF

**GCF — Gas Cost Factor (Primary):**
Minting XEN on Ethereum costs far more in gas than on Polygon. The GCF captures how much real-world economic effort (in ETH-equivalent) it takes to produce one XEN on each chain.

**PF — Price Factor (Secondary, Dampened):**
The market price of each chain's XEN relative to Ethereum's XEN. As burns reduce on-chain supply, the XEN price tends to rise — increasing PF and rewarding future burners with higher scores. This creates a natural flywheel: **burn → supply ↓ → price ↑ → CWF ↑ → more XNT per burn**.

- Uses a **7-epoch rolling EMA** (Exponential Moving Average) to resist short-term manipulation
- **Cube-root dampening** (`^0.33`): price is a differentiator, never the dominant factor
- **Hard cap** `[0.20×, 5.00×]`: PF can never crash or explode scores

| Price(chain) / Price(ETH) | PF Effect | Interpretation |
|:-------------------------:|:---------:|:---------------|
| 100× (chain very scarce)  | 4.64×     | Major bonus — heavy burns depleted supply |
| 10×                       | 2.15×     | Moderate scarcity bonus |
| 1× (parity)               | 1.00×     | Neutral — no PF effect |
| 0.1× (chain abundant)     | 0.46×     | Mild reduction — chain XEN still cheap |
| 0.01× (100× cheaper)      | 0.22×     | Further dampens already-low-CWF chains |

> **Why price matters for solvency:** The Forge is only useful if your XNT earnings from burning XEN exceed what you'd get from selling XEN and buying XNT directly. PF helps maintain this incentive by automatically making burns more valuable as supply is depleted — aligning the protocol's reward signal with real market economics.

### Seed CWF Values (Epoch 0)

| Chain | Token | CWF Seed | Tokens needed vs 1 ETH-XEN | Unlock Day |
|-------|-------|:--------:|:---------------------------:|:----------:|
| Ethereum | XEN | **1.000×** | 1× | Day 0 |
| Optimism | opXEN | **0.880×** | ~1.1× | Day 0 |
| Base | baseXEN | **0.850×** | ~1.2× | Day 39 |
| Avalanche | aXEN | **0.095×** | ~10.5× | Day 26 |
| BSC | bXEN | **0.045×** | ~22× | Day 13 |
| PulseChain | XEN | **0.020×** | ~50× | Day 39 |
| Polygon | mXEN | **0.010×** | ~100× | Day 26 |

> [!NOTE]
> These are epoch-0 seed values. The Oracle recalculates CWF on-chain each epoch using live AMP, gas, and price data. Each component is capped at ±20% change per epoch to prevent manipulation. The full snapshot — including ISF, GCF, PF, and final CWF per chain — is published in `proofs.json` alongside the Merkle root for full verifiability.

### Why Square Root?

The `√` in the formula compresses whale advantage. Burning 4× more XEN gives only 2× more points — keeping the community competitive against large holders.

### Calculation Example

| Scenario | Burn | CWF | xenNorm | √xenNorm | Tier | Final Score |
|----------|------|-----|---------|----------|------|-------------|
| ETH, Orbit, no NFT | 1,000,000 XEN | 1.000 | 1,000,000 | 1,000 | 2.0× | **2,000 pts** |
| ETH, Moon Landing, +10% NFT | 1,000,000 XEN | 1.000 | 1,000,000 | 1,000 | 3.0× | **3,300 pts** |
| Polygon, Orbit, no NFT | 1,000,000 mXEN | 0.010 | 10,000 | 100 | 2.0× | **200 pts** |
| Polygon, Orbit, no NFT (100M) | 100,000,000 mXEN | 0.010 | 1,000,000 | 1,000 | 2.0× | **2,000 pts** |

---

## 3. Mission Tiers

Rewards are vested. Longer lock = higher multiplier.

| Mission | Duration | Multiplier | Penalty (Early Exit) | Best For |
|:--------|:---------|:-----------|:---------------------|:---------|
| 🚀 **Launchpad** | 5 days | **1.0×** | 0% | Testing, low risk |
| 🛸 **Orbit** | 45 days | **2.0×** | 20% | Balanced risk/reward |
| 🌙 **Moon Landing** | 180 days | **3.0×** | 50% | Maximum believers |

> [!NOTE]
> Penalties apply only to the **unvested** balance. Already-vested XNT is never penalised. The penalty amount is split: 93.5% goes back to the reward pool, benefiting patient pilots.

---

## 4. Artifacts (NFT Boosters)

Optional boost NFTs that increase your Forge Score. There are 1,000 total.

| Tier | Name | Supply | Base Price | Boost | Ratio | For |
|:-----|:-----|:-------|:-----------|:------|:------|:----|
| 0 | Lunar Dust | 600 | **5 XNT** | +5% | 1 XNT per 1% | Any pilot |
| 1 | Cosmic Shard | 300 | **10 XNT** | +10% | 1 XNT per 1% | Any pilot |
| 2 | Solar Core | 90 | **20 XNT** | +20% | 1 XNT per 1% | Any pilot |
| 3 | Void Anomaly | 10 | **50 XNT** | +50% | 1 XNT per 1% | Recommended for Moon Landing |

> **Pricing model:** All Artifact tiers share the same ratio — **1 XNT per 1% boost**. This is intentional: the protocol never overcharges for low-tier NFTs. Break-even on any tier = 100 XNT epoch allocation.

> Void Anomaly's +50% boost is most impactful on 180-day Moon Landing missions. This is a UI recommendation only — the contract does not enforce tier restrictions on NFT purchases.

### Dynamic Pricing

- **Lunar Dust (Tier 0):** Fixed price — always **5 XNT**
- **Tiers 1–3:** Dynamic pricing
  - Each purchase → **+5%** to next buyer's price
  - No sale for 7 days → **−5%** price decay (floor: original base price — enforced in contract, never lower)

### NFT Lifecycle

1. **Buy** on the Marketplace
2. **Equip** before burning — boost is applied at burn time
3. **Lock** during mission — NFT cannot be sold or transferred
4. **Release** when mission completes or you eject — returns to your wallet

> [!WARNING]
> **Recycling:** When someone ejects early, their NFT returns to the marketplace at the current dynamic price — not at base price. This creates "snipe windows" for alert buyers.

---

## 5. Epochs & Oracle

> [!IMPORTANT]
> Moon Forge operates in **7-day Epochs**. You cannot start a mission immediately after burning.

### Timeline

| Phase | Timing | What Happens |
|-------|--------|--------------|
| Burns collected | Day 1–7 | Burn events recorded on-chain |
| Epoch closes | Day 7 | No more burns counted for this epoch |
| Oracle calculates | Day 7–8 | Scores, CWF, Merkle tree generated |
| Vesting begins | Day 8+ | Pilots can initialize missions and claim |

### What the Oracle Does

1. Reads `MissionStarted` events from all active EVM chains
2. Calculates epoch CWF v2 from on-chain AMP, gas prices, and XEN market prices
3. Applies `Score = √(XEN_norm × CWF) × tier × nftBonus × streakMultiplier` for each pilot
4. Updates streak flywheel counters (pilots who burned above the minimum qualify)
5. **Reads X1 pool balance** and multiplies by **0.90 (Artifact Boost Safety Factor)**
6. Distributes `epochBudget = pool_balance × 0.90` proportionally: `pilot_allocation = (pilot_score / total_scores) × epochBudget`
7. Generates a Merkle tree — one leaf per pilot: `keccak256(pubkey_32bytes || amount_8bytes_LE || tier_1byte)`
8. Publishes the Merkle root to `MoonForgeBase` on X1 SVM (Anchor program)
9. Publishes `proofs.json` containing:
   - Individual Merkle proofs per pilot
   - `cwfSnapshot`: final CWF per chain this epoch
   - `priceFactorSnapshot`: PF used per chain (with EMA price) — full audit trail
   - Streak info per pilot (epochs, multiplier) — transparent in proofs.json

All proofs are verifiable on-chain. No trust required beyond the math.

### Oracle Safety Factor — Protecting the Vault

Artifact NFT boosts are applied **at contract level** on top of oracle allocations. The oracle must reserve capacity for this extra demand:

```
Max extra demand (worst-case, all 1,000 Artifacts equipped):
  600 × +5%  = +3,000 units
  300 × +10% = +3,000 units
   90 × +20% = +1,800 units
   10 × +50% =   +500 units
  ─────────────────────────
  Total:      +8,300 / 1,000 = 8.3% extra per pilot (average)

Safety factor: 1.0 - 0.10 = 0.90  (10% reserve ≥ 8.3% max exposure)
```

The oracle sets `epochBudget = pool_balance × 0.90`. This guarantees the vault never runs dry even if every pilot burns with a maximum Artifact equipped.

---

## 5.A. Streak Flywheel — Consistency Incentive

Pilots who burn XEN consistently across consecutive epochs earn a **Streak Multiplier** that increases their score proportionally — at no cost to anyone else, since the fixed epoch budget is simply redistributed.

### Formula

```
Streak_Multiplier = 1 + min(0.15, 0.05 × log₂(streakEpochs + 1))
```

| Consecutive Epochs | Streak Multiplier | Bonus |
|:-----------------:|:-----------------:|:-----:|
| 0 (no streak) | 1.000× | +0% |
| 1 | 1.050× | +5.0% |
| 2 | 1.079× | +7.9% |
| 3 | 1.100× | +10.0% |
| 7+ | **1.150×** | **+15.0% (cap)** |

The cap is reached at ~7 epochs, rewarding consistent veterans without creating runaway advantages.

### Break Rules (Forgiving Design)

| Missed Epochs | Consequence |
|:-------------:|:------------|
| Miss **1** epoch | streak = `floor(streak ÷ 2)` — partial credit preserved |
| Miss **2+** epochs | streak = 0 — full reset |

Life happens. One missed epoch doesn't erase your history.

### Minimum Burn to Qualify (Dust Guard)

A burn only counts toward streak if your epoch `rawScore = √(xenNorm) ≥ 10.0`. This prevents players from burning tiny dust amounts just to keep streak benefits alive.

The threshold is calibrated per chain via CWF (auto-updates each epoch):

| Chain | CWF Seed | Min XEN to qualify |
|-------|:--------:|:------------------:|
| Ethereum | 1.000 | ≥ 100 XEN |
| Optimism | 0.880 | ≥ 115 XEN |
| Base | 0.850 | ≥ 118 XEN |
| Avalanche | 0.095 | ≥ 1,053 XEN |
| BSC | 0.045 | ≥ 2,223 XEN |
| PulseChain | 0.020 | ≥ 5,000 XEN |
| Polygon | 0.010 | ≥ 10,000 XEN |

> [!NOTE]
> Dust burns (below the minimum) are **still allocated XNT** proportionally — they just don't advance the streak counter. No burn is wasted.

### Solvency Safety

Streak multipliers only redistribute within the fixed `epochBudget`. The math is identical to any other proportional multiplier: if pilot A gets a 15% streak bonus, the total score pool increases by 15% of A's contribution, and all other pilots' *proportional shares* naturally adjust downward slightly. **No new XNT is ever created.** Total XNT distributed always equals `epochBudget`.

---

### Epoch Isolation — No Cross-Epoch Mixing

Each epoch is a **fully independent distribution cycle**:

```
Epoch N budget  = XNT available for pilots who burned in Week N
Epoch N+1 budget = XNT available for pilots who burned in Week N+1
```

Burns from Epoch N never compete with burns from Epoch N+1. You only compete with pilots who burned in the same 7-day window. Late entrants get their own isolated pool — they do not dilute existing pilots.

---

## 6. Claiming XNT

- **Linear Vesting:** Rewards unlock gradually over the tier duration
- **Manual Claim:** XNT does NOT auto-transfer — you must click Claim on Mission Control
- **Partial Claims:** You can claim any vested amount at any time
- **Gas Tip:** Batch claims (fewer transactions) save gas on X1

### Vesting Rate

| Tier | Duration | Daily Vest Rate |
|------|----------|----------------|
| Launchpad | 5 days | 20%/day |
| Orbit | 45 days | ~2.22%/day |
| Moon Landing | 180 days | ~0.56%/day |

---

## 7. Economics — Where XNT Comes From

### Fee Split v12.0 (Applied to Early-Exit Penalties Only)

Normal XEN burns have **zero fees**. The split below applies exclusively to `eject_pilot()` penalty amounts on X1 SVM:

| Destination | Percentage | Purpose |
|-------------|------------|---------|
| **Reward Pool** | **93.5%** | Back to patient pilots (95.5% if no referrer) |
| Oracle Gas | 1.0% | Covers oracle infrastructure costs |
| Referrer | 2.0% | Referral reward (0% if no referrer — those 2% go to pool) |
| Architect (Dev) | 2.0% | Protocol development — immutable X1 address |
| Dev Escrow | 1.5% | Community incentive — held 4 epochs; released to pool if growth ≥ 95% |

> **If no referrer:** the unused 2% referrer share stays in the **Reward Pool** (not to dev). Pool receives 95.5%.

> **Dev Escrow is not a dev bonus.** It's held trustlessly on-chain. If the protocol grew at least 95% vs. the previous 4-epoch cycle, 100% goes to the pool. If not, it stays locked until the goal is met. No manual release possible.

### NFT Artifact Purchase Fee Split

NFT purchases use a **different split** — governed by the MoonArtifacts program (Rust/Anchor on X1 SVM):

| Destination | Percentage | Purpose |
|-------------|------------|---------|
| **Reward Pool** | **95.5%** | Funds pilot rewards |
| Oracle Gas | 1.0% | Oracle infrastructure |
| Referrer | 2.0% | Referral reward |
| Architect | 1.5% | Protocol architect wallet |

> The 1.5% Architect split on NFT sales is intentionally different from the penalty split. NFT revenue flows more to the pool (95.5% vs 93.5%).

### Pool Funding Sources — All 5 Streams

| Source | Pool Gets | Notes |
|--------|-----------|-------|
| 💚 **Donations** | **100%** | Zero fees — guaranteed by `donate()` function |
| NFT Artifact sales | 95.5% | +5%/−5% dynamic pricing, supply 1,000 |
| Early-exit penalties | 93.5% | Primary recycling mechanism |
| Game fees | 100% to pool | Fee extracted from bets, then 100% of that fee → pool |
| NFT recycling | Market-driven | Ejected NFT re-enters market at current dynamic price |

> **Donations are unique**: the `donate()` function in MoonForgeBase.sol contains no transfer logic — it only accepts and emits a `Donated(donor, amount)` event. The full amount remains in the contract balance (= reward pool). Verifiable by inspecting contract bytecode.

---

## 8. Rollout Schedule

Chains activate progressively to ensure Oracle stability. The Oracle automatically starts indexing each chain once its `.env` portal address is configured — no code changes required.

| Phase | Day | Chains | Rationale |
|-------|:---:|--------|-----------|
| **Launch** | 0 | Ethereum, Optimism | Highest CWF chains, most battle-tested infrastructure |
| **Phase 2** | 13 | BSC | High liquidity, stable RPC, 2 weeks for Oracle to stabilise |
| **Phase 3** | 26 | Polygon, Avalanche | Lower CWF chains — added after burn patterns established |
| **Phase 4** | 39 | **Base, PulseChain** | L2 + PulseChain community support added at full rollout |

All chains burn into the **same X1 Reward Pool**. The Oracle aggregates burns from all active chains per epoch, applying the correct CWF per chain to each burn event.

---

## 8.A. Solvency Guarantees — Mathematical Proof

Moon Forge is designed so that the vault can **never run dry** through normal operation. Every layer of the reward system has hard mathematical bounds.

### Layer 1 — Oracle Budget Safety Factor

```
epochBudget = pool_balance × 0.90
```

The Oracle reads the live vault balance before each epoch and allocates only 90% of it. The remaining 10% acts as a permanent reserve buffer.

### Layer 2 — Artifact Boost Capacity

Artifact NFT boosts are applied at contract level *on top of* oracle allocations. In the absolute worst case (all 1,000 Artifacts equipped simultaneously by 1,000 different pilots):

```
600 Lunar Dust   × +5%  = 3,000 boost-units
300 Cosmic Shard × +10% = 3,000 boost-units
 90 Solar Core   × +20% = 1,800 boost-units
 10 Void Anomaly × +50% =   500 boost-units
──────────────────────────────────────────────
Extra demand / 1,000 pilots = +8.3% average per pilot

Reserve buffer: 10%  ≥  8.3% worst-case extra demand  ✅
```

The 10% reserve is larger than the maximum possible Artifact demand. **Vault solvency is proven under worst-case conditions.**

### Layer 3 — Proportional Distribution

Every multiplier in the system (Tier, NFT, Streak, PF) is applied **before** the distribution ratio is computed. The distribution is always:

```
pilot_XNT = (pilot_total_score / sum_all_scores) × epochBudget
```

This is a proportional identity: the sum of all ratios always equals 1.0. **Total XNT paid = epochBudget always**, regardless of how large or small individual multipliers are. No multiplier creates new XNT — it only adjusts the internal redistribution.

### Layer 4 — Price Factor Safety

The PF is double-capped:
- **EMA smoothing (7 epochs)**: a single spike in XEN price cannot immediately increase CWF
- **Hard cap [0.20×, 5.00×]**: PF can never produce a zero or infinite score

### Layer 5 — Minimum Burn (Dust Guard)

The `minRawScore = 10.0` threshold (= √(xenNorm) ≥ 10 → xenNorm ≥ 100 CWF-adjusted XEN) prevents:
- Streak gaming: tiny dust burns don't qualify for streak credit
- Proportional dilution: very small burns still receive proportional XNT, but can't exploit streak benefits disproportionately

### Economic Incentive Condition

> **The Forge must always be more rewarding than the spot market.**

For the protocol to remain attractive, the value of XNT earned must exceed the value of XEN burned at current market rates. This is maintained by:

1. **CWF Price Factor**: as burns deplete supply → XEN price rises → PF rises → future burns earn more XNT proportionally
2. **Fixed supply XNT distribution**: more burns from a chain create competition, but that competition raises the chain's XEN price, which is then captured by PF
3. **Pool growth flywheel**: XNT earned → used to buy more XEN → burned → more XNT earned → pool grows via NFT sales and penalties

> [!NOTE]
> Moon Forge cannot guarantee spot price ratios — markets are unpredictable. However, the economic design deliberately creates forces that tend to keep burning advantageous over time, especially for early participants who burn before supply depletion drives prices up.

---

## 8.B. End-to-End Simulation — Seeing the Math in Action

This section walks through a complete worked example with real numbers: 5 pilots, multiple chains, different tiers, early exits, games, the oracle ceiling, DevEscrow, and a second mission — to prove that every XNT goes exactly where it should.

### Setup — Initial State

```
reward_vault (XNT pool):    200,000 XNT  (pre-funded before epoch 1)
bankroll_vault (games):      10,000 XNT  (separate — never mixes with missions)
dev_escrow_vault:                 0 XNT
```

---

### Step 1 — Five Pilots Burn XEN on Different Chains

| Pilot | Chain | XEN Burned | CWF Seed | XEN×CWF | Tier | MoonCommander? |
|-------|-------|-----------|----------|---------|------|----------------|
| Alice | ETH | 1,000,000 | 1.000 | 1,000,000 | 🌙 Moon Landing (180d) | ✅ |
| Bob | ETH | 500,000 | 1.000 | 500,000 | 🛸 Orbit (45d) | ✅ |
| Carol | Polygon | 10,000,000 mXEN | 0.010 | 100,000 | 🌙 Moon Landing (180d) | ❌ |
| Dave | BSC | 5,000,000 bXEN | 0.045 | 225,000 | 🚀 Launchpad (5d) | ❌ |
| Eve | Optimism | 2,000,000 opXEN | 0.880 | 1,760,000 | 🛸 Orbit (45d) | ❌ |

CWF normalises the economic effort across chains. Polygon's 10 million XEN is effectively worth 100,000 CWF-adjusted units — the same as 100,000 ETH-XEN, because producing mXEN costs ~100× less economic effort.

---

### Step 2 — Oracle Calculates Scores

```
Score = √(XEN × CWF) × Tier_Multiplier × MoonCommander_Bonus

Alice : √1,000,000 = 1,000.00 × 3.0 × 1.1 (MC) = 3,300.00
Bob   : √  500,000 =   707.11 × 2.0 × 1.1 (MC) = 1,555.63
Carol : √  100,000 =   316.23 × 3.0 × 1.0      =   948.68
Dave  : √  225,000 =   474.34 × 1.0 × 1.0      =   474.34
Eve   : √1,760,000 = 1,326.65 × 2.0 × 1.0      = 2,653.30

Total Score = 8,931.95
```

The **square root** means Alice burned 2× more than Bob on the same chain — but only got 41% more score, not 2× more. This is how Moon Forge keeps competition fair.

---

### Step 3 — XNT Allocation (Epoch Budget = 100,000 XNT)

```
epochBudget = reward_vault × 0.90 = 200,000 × 0.90 = 180,000 XNT available
Epoch 1 uses 100,000 XNT (5 pilots, proportional to score)

pilot_XNT = (pilot_score / total_score) × epochBudget
```

| Pilot | Score | Share | XNT Allocated | Tier Duration |
|-------|-------|-------|---------------|---------------|
| Alice | 3,300.00 | 36.95% | **36,950 XNT** | 180 days |
| Bob | 1,555.63 | 17.42% | **17,420 XNT** | 45 days |
| Carol | 948.68 | 10.62% | **10,620 XNT** | 180 days |
| Dave | 474.34 | 5.31% | **5,310 XNT** | 5 days |
| Eve | 2,653.30 | 29.70% | **29,700 XNT** | 45 days |

**Total allocated: 100,000 XNT** — reward_vault goes from 200,000 → 100,000 XNT (the other 100,000 XNT stay in the vault for future epochs).

Each pilot's XNT is immediately transferred to their **own isolated VestingAccount PDA** on X1. Alice's XNT cannot touch Bob's. The SVM runtime enforces this via cryptographic seeds.

---

### Step 4 — Mission Scenarios

#### Alice — Completes 180-Day Moon Landing (Zero Fees)

```
VestingAccount Alice: 36,950 XNT, 180 days

Day  45: 36,950 × (45/180) =  9,237 XNT vested → Alice claims
Day  90: 36,950 × (90/180) = 18,475 XNT total vested → Alice claims 9,238 more
Day 180: Remaining 18,475 XNT fully vested → Alice claims

Alice receives: 36,950 XNT (100%) + rent refund
Penalty: ZERO — patience is always rewarded in full
Pool: unaffected (XNT came from her isolated VestingAccount, not the shared pool)
```

#### Bob — Ejects on Day 20 (Orbit, 20% Penalty, Has Referrer)

```
Day 15: Vested = 17,420 × (15/45) = 5,807 XNT → Bob claims

Day 20: Bob calls eject_pilot()
  remaining = 17,420 - 5,807 = 11,613 XNT
  penalty   = 11,613 × 20%   = 2,323 XNT
  Bob gets  = 11,613 - 2,323 = 9,290 XNT returned

  Penalty distribution (2,323 XNT — WITH referrer):
    Oracle   (1.0%) :  23.23 XNT → oracle wallet
    Referrer (2.0%) :  46.46 XNT → referrer wallet
    Architect(2.0%) :  46.46 XNT → your X1 wallet
    DevEscrow(1.5%) :  34.85 XNT → dev_escrow_vault
    Pool    (93.5%) : 2,172.00 XNT → reward_vault (pool grows!)
    ─────────────────────────────────────────────
    Total: 2,323 XNT ✅  (1% + 2% + 2% + 1.5% + 93.5% = 100%)

Bob total received: 5,807 + 9,290 = 15,097 XNT from original 17,420 (87%)
Pool gains: +2,172 XNT — patient pilots benefit from Bob's early exit
```

#### Carol — Ejects Immediately (Moon Landing, 50% Penalty, No Referrer)

```
Carol burned Polygon XEN and changed her mind on Day 0.

eject_pilot():
  remaining = 10,620 XNT (nothing claimed yet)
  penalty   = 10,620 × 50% = 5,310 XNT
  Carol gets: 5,310 XNT returned

  Penalty distribution (5,310 XNT — NO referrer):
    Oracle   (1.0%) :   53.10 XNT → oracle wallet
    Architect(2.0%) :  106.20 XNT → your X1 wallet
    DevEscrow(1.5%) :   79.65 XNT → dev_escrow_vault
    Pool    (95.5%) : 5,071.05 XNT → reward_vault (pool grows more!)
    ─────────────────────────────────────────────
    Total: 5,310 XNT ✅  (without referrer: pool always gets 95.5%)

Pool gains: +5,071 XNT more. Zero-fee exit benefits everyone else.
```

#### Dave — Completes Launchpad (5 Days, 0% Penalty)

```
Dave chose the 5-day tier — no penalty, ever.
  eject_pilot() or claim after 5 days → Dave gets full 5,310 XNT + rent
  Pool: not affected. Dave gets everything.
```

---

### Step 5 — Games (Separate Bankroll, Zero Mission Impact)

```
Eve has her mission (29,700 XNT vesting) AND plays games simultaneously.
Games use bankroll_vault ONLY — completely separate from all missions.

Eve bets 100 XNT on Coin Flip:
  Max bet = bankroll (10,000) × 2% = 200 XNT → 100 XNT is fine

  WIN (1.96×): Eve receives 196 XNT from bankroll
    bankroll: 10,000 - 196 = 9,804 XNT

  LOSE: Eve's 100 XNT enters bankroll, then:
    50% (50 XNT) → reward_vault (SUBSIDY to all burners!)
    2%  ( 2 XNT) → architect wallet
    48% (48 XNT) → stays in bankroll
    bankroll: 10,000 + 100 - 50 - 2 = 10,048 XNT

Jackpot (~1.95% chance, 10× payout):
  Eve bets 10 XNT; max_jackpot_bet = bankroll × 0.5% = 50 XNT
  WIN: Eve receives 100 XNT from bankroll
  LOSE: 5 XNT → pool subsidy, 0.2 XNT → architect, 4.8 XNT → bankroll

Every game loss pumps XNT into the reward pool — games fuel burner rewards.
```

---

### Step 6 — Oracle Ceiling (25 XNT Cap)

```
Over 7 epochs the oracle wallet accumulates penalty shares:
  ~53 XNT (Carol epoch 1) + ~23 XNT (Bob epoch 1) + ~5 XNT/epoch × 5 = 101 XNT total

Oracle balance: 101 XNT → above the 25 XNT ceiling

x1Publisher.ts detects: balance (101) > ORACLE_XNT_CEILING (25)
excess = 101 - 25 = 76 XNT

oracle calls donate(76 XNT):
  76 XNT → reward_vault (100% to pool — no fees on donations)
  oracle wallet stays at 25 XNT

Oracle never hoards. Excess always returns to pilots.
```

---

### Step 7 — DevEscrow: Met Goal vs. Missed Goal

```
dev_escrow_vault accumulates 1.5% of all penalties:
  After 4 epochs: 79.65 + 34.85 + ~50 XNT avg × 2 more = ~215 XNT

Anyone calls release_dev_escrow() at epoch 4:

  Scenario A — Protocol grew (cycle volume ≥ 95% of last cycle):
    Example: Cycle 1 = 380,000 XNT burned | Cycle 2 = 410,000 XNT burned
    410,000 ≥ 380,000 × 95% (361,000) → GOAL MET ✅
    → 215 XNT from escrow → reward_vault (back to pilots!)

  Scenario B — Protocol stagnated (cycle volume < 95%):
    Example: Cycle 1 = 380,000 XNT | Cycle 2 = 350,000 XNT
    350,000 < 361,000 → GOAL MISSED ❌
    → Escrow STAYS LOCKED — accumulates for the next cycle
    → Dev receives nothing. Protocol growth is the only release key.

DevEscrow aligns dev incentives with protocol success.
If the platform grows, community gets it all back.
If it stagnates, no one gets the escrow — it stays for the next chance.
```

---

### Step 8 — Second Mission After Exit (PDA Reuse)

```
Bob ejected in Epoch 1. His VestingAccount PDA:
  initialized = false, lamports = 0 (rent was returned to Bob)
  SVM automatically removes zero-balance accounts.

Epoch 2: Bob burns XEN again. Oracle publishes new Merkle root.
Bob calls claim_and_start_mission(epoch=2, amount=25,000 XNT, tier=1):

  ClaimReceipt PDA: seeds = [b"claim_receipt", epoch_2_bytes, Bob_pubkey]
    → New receipt (epoch 2 ≠ epoch 1) → anti-replay per epoch ✅

  VestingAccount PDA: seeds = [b"vesting", Bob_pubkey]
    → init_if_needed: PDA was removed → creates fresh ✅
    → initialized = false (no active mission) → constraint passes ✅
    → New mission starts: 25,000 XNT, Tier 1, 45 days

Bob's second mission runs completely independently from epoch 1.
No state from the first mission survives. Clean slate.
```

---

### Final Accounting — Where Every XNT Went

```
SYSTEM STARTED WITH:
  reward_vault:   200,000 XNT

MISSIONS (Epoch 1 — 100,000 XNT left the pool into isolated VestingPDAs):
  Alice VestingPDA: +36,950 XNT  → Alice claims all 36,950 XNT (full completion)
  Bob VestingPDA:   +17,420 XNT  → Bob gets 15,097; pool gets back 2,172; escrow 35; oracle 23; ref 46; architect 46
  Carol VestingPDA: +10,620 XNT  → Carol gets 5,310; pool gets back 5,071; escrow 80; oracle 53; architect 106
  Dave VestingPDA:   +5,310 XNT  → Dave gets full 5,310 XNT
  Eve VestingPDA:   +29,700 XNT  → Eve claims linearly over 45 days

POOL BALANCE EVOLUTION:
  Start:                       200,000 XNT
  After epoch 1 allocations:   100,000 XNT (100k in VestingPDAs)
  Bob penalty back to pool:   +  2,172 XNT
  Carol penalty back to pool: +  5,071 XNT
  Game losses subsidy:        +    500 XNT (estimated)
  Oracle ceiling donation:    +     76 XNT
  DevEscrow released (cycle3):+    215 XNT  (when growth goal met)
  Pool after all above:       ~108,034 XNT (growing — more than before epoch 1 exits)

EVERY XNT IS ACCOUNTED FOR. NOTHING LEAKS. NOTHING IS CREATED.
Early exits → benefit patient pilots.
Game losses → subsidise burners.
Oracle overflow → returns to community.
Protocol growth → unlocks escrow back to pool.
```

---

> [!NOTE]
> This simulation uses **seed CWF values** (Epoch 0). In practice, CWF recalculates every epoch using live AMP, gas prices, and EMA market prices — scores drift over time. The math structure is identical; only the CWF numbers change. Every oracle epoch, the complete snapshot is published in `proofs.json` for anyone to verify.

---

## 9. Moon Party — Potential Eligibility

> [!WARNING]
> Moon Party rules are **not officially confirmed**. Criteria have changed before and may change again. Nothing below is guaranteed by Moon Forge.

Moon Forge burns XEN permanently on-chain. These transactions are public, verifiable facts recorded forever on each EVM chain's blockchain.

**What this means:** If the X1 ecosystem or any future XEN program evaluates on-chain burn history as part of eligibility criteria, Moon Forge pilots will already have verifiable proof of their economic contribution to XEN deflationary mechanics.

**What this does NOT mean:** Moon Forge cannot guarantee any third-party program's eligibility. Follow official X1 and XEN community channels for authoritative announcements.

---

## 10. Donations — 100% to Reward Pool

> [!IMPORTANT]
> Donations are the **only funding stream with zero deductions**. Every XNT donated goes directly and entirely to the reward pool — guaranteed by contract code, not by policy.

### On-Chain Guarantee

The `donate()` instruction in the X1 Anchor program:

```rust
pub fn donate(ctx: Context<Donate>, amount: u64) -> Result<()> {
    require!(amount > 0, ForgeError::InvalidAmount);
    invoke(
        &system_instruction::transfer(
            &ctx.accounts.donor.key(),
            &ctx.accounts.reward_vault.key(),
            amount,
        ),
        &[ ctx.accounts.donor.to_account_info(),
           ctx.accounts.reward_vault.to_account_info() ],
    )?;
    emit!(Donated { donor: ctx.accounts.donor.key(), amount });
    Ok(())
}
```

No fee logic, no deduction, no redirect. 100% of the `amount` goes directly to `reward_vault`. The `Donated` event is emitted on-chain for every donation — verifiable on any X1 block explorer.

### All Pool Sources Compared

| Source | Pool Gets | Has Fee Split? |
|--------|-----------|---------------|
| **Donations** | **100%** | **No — enforced by code** |
| NFT Artifact sales | 95.5% | Yes (4.5% oracle/ref/architect) |
| Early-exit penalties | 93.5% | Yes (6.5% oracle/ref/dev) |
| Game protocol fees | 100% | No (fees taken from bets, not from pool contribution) |

---

## 11. Security & Risks

### Protocol Security

- **Merkle Proofs:** Your XNT allocation is cryptographically verified — no admin can alter individual claims
- **Non-Custodial:** Only your wallet can claim your vested rewards
- **Open Source:** All contracts available for community audit

### Risk Matrix

| Risk | Severity | Mitigation |
|------|----------|------------|
| Oracle downtime | Medium | Burns recorded on-chain; claims delayed, not lost |
| Smart contract bug | High | Audited; open source |
| Pool runs low | Medium | Games, penalties, and donations continuously refill it |
| X1 chain risk | High | Moon Forge is NOT the X1 team; X1 failure = XNT impact |
| XEN price crash | Low | CWF ISF + GCF are not USD-based; PF dampened by `^0.33` |
| PF price manipulation | Low | 7-epoch EMA + ±20% epoch cap + [0.20×, 5×] hard cap |
| Streak gaming (dust burns) | Very Low | Minimum rawScore threshold — dust burns ignored for streak |
| Vault insolvency (Artifacts) | Very Low | 10% reserve proven ≥ 8.3% worst-case Artifact demand |

> [!CAUTION]
> - Burning XEN is **permanent and irreversible**
> - Lost wallet keys = lost unvested XNT and locked NFTs
> - No admin backdoor for recovery

---

## 12. Frequently Asked Questions

**Q: Is Moon Forge official?**
A: No. Moon Forge is a community protocol with no affiliation to the X1 team.

**Q: Why does my Polygon burn score less than the same amount on Ethereum?**
A: CWF reflects the actual economic effort per token. Polygon mXEN has a very large supply and low minting cost vs Ethereum. To earn equal points, you need ~100× more mXEN than ETH-XEN — which roughly reflects the real market ratio.

**Q: Can I burn on multiple chains in the same epoch?**
A: Yes. The Oracle aggregates all your burns across chains and applies the correct CWF per chain.

**Q: Does Moon Forge guarantee Moon Party eligibility?**
A: No. Burns are real on-chain facts. Whether any future program recognises them is entirely outside our control.

**Q: What happens to the penalty when I eject?**
A: 93.5% returns to the reward pool (benefiting patient pilots), 1% funds Oracle gas, 2% goes to your referrer (if any), 2% goes to the architect wallet, and 1.5% goes to the Dev Escrow (held trustlessly — returned to pool if protocol grows ≥95%). If you have no referrer, the pool receives 95.5%.

**Q: Can I have multiple missions at once?**
A: One active mission per wallet per epoch. Each epoch claim creates an isolated VestingAccount PDA on X1 — your XNT is never mixed with another pilot's balance. After completing or ejecting, you can start a new mission in the next epoch.

**Q: When should I equip the NFT?**
A: Before burning. The boost is calculated at burn time and cannot be applied retroactively.

**Q: Are rewards guaranteed?**
A: No. Your XNT reward is a proportional share of the epoch pool. If the pool is small, rewards are small.

**Q: Do burns from different epochs compete with each other?**
A: No. Each 7-day epoch is completely isolated. You only compete with pilots who burned in the same epoch window. Late burners get their own separate budget.

**Q: Does burning XEN on a chain affect the CWF for that chain?**
A: Not directly. AMP is time-based only — it drops 1 per day regardless of burns. However, burns reduce the circulating supply of XEN on that chain, which tends to push the market price higher. The Price Factor (PF) in CWF v2 captures this: as price rises, PF rises, making future burns on that chain worth more points. This is the burn-supply-price flywheel.

**Q: What is the Streak Multiplier and how do I earn it?**
A: If you burn XEN in consecutive epochs (above the minimum threshold), you accumulate a streak. After 1 epoch: +5% bonus. After 3: +10%. After 7+: +15% (cap). Miss one epoch: your streak is halved (not lost). Miss two: reset. Streak multipliers only redistribute within the fixed epoch budget — they never create new XNT.

**Q: What is the minimum burn to qualify for streak credit?**
A: Your aggregated rawScore for the epoch must be ≥ 10.0 (`√(xenNorm) ≥ 10`). That's roughly 100 CWF-adjusted XEN — about 100 ETH-XEN or 10,000 Polygon-mXEN. Dust burns are still allocated XNT proportionally; they just don't advance the streak counter.

**Q: Why does the Price Factor use a 7-epoch EMA instead of the live price?**
A: A single day's price can be manipulated via a flash loan or coordinated trade. A 7-epoch EMA (7 weeks of data) makes this kind of attack economically impractical — an attacker would need to sustain artificial prices for weeks while also absorbing the cost of maintaining them.

**Q: Are Base and PulseChain supported?**
A: Yes. Both are supported from Day 39 (Phase 4). Base XEN has CWF 0.850 (similar to Optimism), and PulseChain XEN has CWF 0.020. Both contribute to the same X1 reward pool.

**Q: If I donate, does 100% go to the pool?**
A: Yes. The `donate()` function is the only action with zero fee split. It is enforced by code — there is no fee logic inside the function. Verifiable on any X1 block explorer.

**Q: Why is the NFT fee split (1.5% architect) different from the penalty split (3.5% dev)?**
A: They are governed by separate, immutable contracts. Both are intentional design decisions. NFT sales route more to the pool (95.5%); penalties route a slightly smaller pool share (93.5%) but the dev/architect difference reflects different funding contexts.

**Q: Can the NFT price fall below its original base price?**
A: No. The price floor is the original base price set at deployment and is enforced in the contract. For example, Cosmic Shard can never cost less than 10 XNT, regardless of how many decay periods pass. Lunar Dust is fixed at 5 XNT always.

---

## Glossary

| Term | Definition |
|------|------------|
| **XEN** | Token burned. Exists on multiple EVM chains (ETH-XEN, opXEN, bXEN, mXEN, aXEN, baseXEN, PLS-XEN) |
| **XNT** | Reward token on X1 blockchain (9 decimals, SVM-style lamports) |
| **CWF** | Chain Weight Factor — `normalize(ISF × GCF × PF)`. ETH = 1.0 anchor. Recalculated every epoch. |
| **ISF** | Inflation Scarcity Factor — `AMP_max / AMP_current`. Captures XEN's built-in deflation rate per chain. |
| **GCF** | Gas Cost Factor — `gas_ETH / gas_chain`. Captures the real economic effort (gas) to mint XEN on each chain. |
| **PF** | Price Factor — `(price_chain_EMA7 / price_ETH_EMA7) ^ 0.33`. Captures market price of XEN relative to ETH-XEN. Dampened to secondary role. |
| **AMP** | XEN Amplifier — starts at 3,000, drops 1/day (time-based only). Lower AMP = higher ISF = more valuable burns. |
| **EMA** | Exponential Moving Average — 7-epoch rolling price average used by PF to resist manipulation. |
| **Forge Score** | `√(XEN_norm × CWF) × Tier × NFT × Streak` — your proportional share claim on the epoch pool. |
| **xenNorm** | `XEN_burned × CWF` — CWF-normalised burn amount used inside the square root. |
| **Streak Multiplier** | Consistency bonus: 1.0× to 1.15×, earned by burning in consecutive epochs above minimum threshold. |
| **rawScore** | `√(xenNorm)` — base score before tier/NFT/streak multipliers. Used for streak eligibility check. |
| **Epoch** | 7-day burn aggregation period. Each epoch is fully isolated. |
| **epochBudget** | `pool_balance × 0.90` — XNT available for distribution in one epoch. 10% held as Artifact buffer. |
| **Vesting** | Linear unlock of XNT rewards over the tier's duration. |
| **Eject** | Early exit from a mission — applies tier penalty to unvested balance. |
| **Oracle** | Off-chain service that calculates CWF v2, scores, Merkle proofs, and publishes to X1 SVM. |
| **Merkle Proof** | Cryptographic proof of your epoch allocation — verifiable against on-chain Merkle root. |
| **proofs.json** | Published by Oracle each epoch. Contains individual claims, CWF snapshot, PF snapshot, streak data. |
| **Artifact** | Optional boost NFT — increases Forge Score by 5–50%. Locked during mission. |
| **Void Anomaly** | Rarest Artifact (+50% boost, supply 10). Recommended for Moon Landing missions. |
| **Artifact Boost Safety Factor** | `0.90` — the fraction of pool used as epochBudget. Guarantees 10% reserve ≥ 8.3% worst-case Artifact demand. |
| **Portal** | Smart contract on each EVM chain where XEN is burned (Solidity). |
| **Base (contract)** | Smart contract on X1 SVM where XNT is vested and claimed (Rust/Anchor). |
| **Reward Pool** | Community vault holding XNT for distribution to pilots. |
| **Donation** | Direct XNT contribution to the pool via `donate()`. 100% to pool, zero fees. On-chain `Donated` event. |
| **Epoch Isolation** | Each 7-day epoch is a fully independent distribution cycle — no cross-epoch competition. |
| **NFT Floor Price** | Minimum price an Artifact can reach via decay. Equals original base price. Contract-enforced. |
| **X1 SVM** | X1 Blockchain runs the Solana Virtual Machine — uses Base58 addresses, @solana/web3.js, Anchor programs. Not EVM. |

---

## Links

- **GitHub:** [Repository](https://github.com/xen-moon-forge-protocol/Moon-Forge)
- **X1 Blockchain:** [Official Site](https://x1.xyz) | [Explorer](https://explorer.mainnet.x1.xyz) | [Docs](https://docs.x1.xyz)
- **XEN Crypto:** [Official Site](https://xen.network)

---

**The Forge is Lit.** 🌑🔥

*Built by the community, for the community.*
