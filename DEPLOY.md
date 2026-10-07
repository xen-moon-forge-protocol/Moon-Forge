# Deploying Moon Forge v2

Order: **(1) upgrade the X1 program → (2) initialize → (3) deploy EVM portals → (4) start the oracle → (5) seed pools → (6) airdrop list → (7) burn the upgrade authority after the test period.**

Tooling used: solana-cli 3.1.x (Agave), anchor-cli 0.32.1, Rust stable, Node 20+. Build on Linux/WSL in a path without non-ASCII characters (a rustc diagnostics bug crashes on accented paths).

## 1. Upgrade the X1 program (same id `57UE1U…`)

```bash
cargo test -p moon-forge --lib                      # unit tests
bash tests/run-local.sh                             # integration tests (local validator + real Metaplex Core)
cargo build-sbf --manifest-path programs/moon-forge/Cargo.toml   # MAINNET build: never pass --features localnet
sha256sum target/deploy/moon_forge.so               # publish this hash
anchor idl build -p moon_forge -o target/idl/moon_forge.json
```

Costs computed from X1 mainnet rent (2026-10-07) for the v2 binary (845,904 bytes; v1 ProgramData holds 375,752 bytes and 2.616 XNT of rent):

| Step | XNT | Refunded? |
|---|---|---|
| Extend ProgramData to the new size (rent 5.889 − 2.616 already deposited) | **3.272** | stays as the program's rent deposit |
| Temporary write buffer | 5.889 | **yes**, automatically, at the end of the same deploy |
| ~850 write transactions × 1,500 lamports | ~0.002 | no |
| On-chain IDL upgrade (optional, ~20 KB compressed) | ~0.14 | no |
| `npm run init` (config, lottery vault, Core collection) | ~0.01 | no |

The upgrade-authority wallet must hold **≈ 9.2 XNT at the moment of the deploy** (net cost ≈ 3.3 XNT). solana-cli ≥ 2.x extends the ProgramData automatically during `program deploy` (`--no-auto-extend` disables it).

```bash
URL=https://rpc.mainnet.x1.xyz
KEY=~/.config/solana/deploy-wallet.json             # = 7PuG8ELK… (current upgrade authority)
solana program deploy target/deploy/moon_forge.so --program-id 57UE1U1t23ztg2noLp8pcpGW1B1Xw25rLH6ra9Mchea9 \
  --upgrade-authority $KEY -k $KEY -u $URL --with-compute-unit-price 0
anchor idl upgrade --filepath target/idl/moon_forge.json 57UE1U1t23ztg2noLp8pcpGW1B1Xw25rLH6ra9Mchea9 \
  --provider.cluster $URL --provider.wallet $KEY
solana program show 57UE1U1t23ztg2noLp8pcpGW1B1Xw25rLH6ra9Mchea9 -u $URL
```

If a buffer is left behind after a failed attempt: `solana program show --buffers -u $URL` and `solana program close <BUFFER> -u $URL`.

## 2. Initialize (permissionless, values are constants)

```bash
cd oracle && npm install
ORACLE_PRIVATE_KEY="$(cat ~/.config/solana/deploy-wallet.json)" npm run init   # initialize_v2 + init_artifacts + sweep_legacy
```

## 3. EVM portals

```bash
npm install && npx hardhat test
cp .env.example .env                                 # PRIVATE_KEY of a gas-only deployer
npx hardhat run scripts/deploy_portal.ts --network bsc   # repeat: polygon, avalanche, optimism, base, pulsechain, (mainnet)
# Check each chain still has a XEN market first: `cd oracle && npm run market` (a chain without one scores zero —
# Moonbeam had none on 2026-10-07, so no portal there).
```

For each chain record the portal address and its deployment block, then set:
- `frontend/src/lib/constants.ts` → `portalAddress`;
- GitHub repository variables `PORTAL_<CHAIN>` and `START_<CHAIN>` (and `oracle/.env` for local runs).

Verify on the explorers: `npx hardhat verify --network <chain> <portal> <xen>`.

## 4. Oracle

- Fund the oracle key `J5CU45Didfq7ng9JHXyxYqN7TwAGjMgEyhUcrV7Aixba` with ~1 XNT.
- GitHub secret `ORACLE_PRIVATE_KEY`; variable `ORACLE_ENABLED=true`. First run: Actions → "Oracle epoch" → dry run.
- Keeper: enable the GitHub Actions keeper (variable `KEEPER_ENABLED=true`, secret `KEEPER_PRIVATE_KEY`, falling back to `ORACLE_PRIVATE_KEY`) and, because scheduled GitHub runs can be delayed, preferably also run `npm run keeper` on an always-on machine (any funded key; keeping is permissionless).

## 5. Seed the pools

- Bankroll: `house_deposit` from the site (Be the House). Max net win per bet = 0.25% of the free bankroll, so 4,000 XNT allows ~10 XNT wins.
- Reward pool: Donate → Reward pool. Each epoch distributes up to 10% of the free pool.

## 6. Genesis airdrop

The committed `airdrop.json` is a draft (validators only). Rebuild it with the Genesis supporters right before setting the root — `set_airdrop_root` can be called only once and is final:

```bash
node scripts/airdrop/collect-validators.mjs > validators.txt
node scripts/airdrop/collect-donors.mjs > donors.txt
cat donors.txt validators.txt > wallets.txt
node scripts/airdrop/build-airdrop.mjs wallets.txt         # writes frontend/public/airdrop/airdrop.json
# then, once, with the architect key:  set_airdrop_root(<root>)
```

## 7. End of the test period

```bash
solana program set-upgrade-authority 57UE1U1t23ztg2noLp8pcpGW1B1Xw25rLH6ra9Mchea9 --final -k $KEY -u $URL
```

After this nothing in the program can change, including fees and the architect address.
