# Fork Moon Forge, or continue this one

Moon Forge is MIT licensed: anyone may copy, run or change it. Before you fork, decide which of two things you want, because they are different.

## Fork or continue?

| You want to | Do this | What you get |
|---|---|---|
| keep **this** Moon Forge running (the program `57UE1U1t23ztg2noLp8pcpGW1B1Xw25rLH6ra9Mchea9`, its five portals, its pools, its users and Artifacts) after its operator went quiet | **continue it**: run the keeper, verify every epoch, void a wrong one during its hold, and take the oracle seat or the house keeper seat by the program's own rules: [Community takeover runbook](OPERATORS.md#community-takeover-runbook). A fork of the repository is then only where you keep your copy of the code, the site and the epoch files | the same reward pool, extra pot, bankroll and Artifacts, paid out only by the program's rules. You cannot change any rule, fee or split (after the freeze nobody can); you run the open oracle code within the program's bounds |
| other rules, fees, chains or branding, or a program you control | **fork it**: a new instance with its own program id, portals, pools and name (below) | empty pools and no users at the start; nothing from this instance's pools, Artifacts or burns moves to it, and its burners are paid only from its own pool |

Continuing needs the final program (upgrade planned for Wednesday 2026-11-18): the oracle seat, the bonded void and the house keeper seat do not exist in the v2 program that runs until then. What can break, and who can fix it, is in [When something breaks](OPERATORS.md#when-something-breaks).

## A new instance

The program source in this repository is the final program's source. To deploy your own copy of it:

1. **Program id:** generate a keypair (`solana-keygen new -o target/deploy/moon_forge-keypair.json`), put its address in `declare_id!` (`programs/moon-forge/src/lib.rs`) and `Anchor.toml`.
2. **Identities:** in `programs/moon-forge/src/constants.rs` set `ARCHITECT`, `INITIAL_ORACLE`, `INITIAL_KEEPER` and `SEAT_COLD_INITIAL` to keys you generate (four different keys; the mainnet build refuses a placeholder, a published test key, or a cold key equal to another role), and `SEAT_REFUND_INITIAL`. Keep the `localnet` test identities for testing only; their private keys are public in `tests/fixtures`.
3. **Economics and dates:** fees, splits, tiers, prices, budgets, bonds and delays are constants in the same file, and so are the dates (`PRICE_LAUNCH_TS`, `KEEPER_OPEN_TS`, `AIRDROP_DEADLINE`); the compile-time asserts keep the splits summing to 100% and the bonds consistent.
4. **Metadata and branding:** your own name, art and texts, your own Arweave upload, and `METADATA_BASE_URI` pointing at it (the mainnet build refuses anything but a final `https://<gateway>/<43-character id>/` path); `COLLECTION_NAME`; `SITE` in `scripts/nft-metadata/tiers.mjs`; `GITHUB_URL` and the Vite `base` in the frontend. Use your own name, so nobody mistakes your instance for this one.
5. **Clients:** rebuild the IDL (`anchor idl build --no-docs`) and copy it to the oracle and frontend IDL folders (the new-program copies, `moon_forge.v3.json`); update the program id and the identities in `frontend/src/lib/`, `agents/kit/` and `oracle/src/`.
6. **Oracle policy:** the reward rules live in `oracle/src/` (`config.ts`, `rewards.ts`, `extra.ts`, `rules-v3.ts`); they are yours to change, and every epoch file records the rules it was built with. Replace `deployments/portals.json` with your own portals: the oracle and every workflow take the portals and their start blocks from that file alone (no `PORTAL_<X>` / `START_<X>` repository variable; those environment overrides exist only for local tests, and an empty one skips the chain). The Legacy Pilot rule and its list (`oracle/src/legacy.ts`, `deployments/legacy-burners.json`) belong to this instance's rules: keep, change or drop them in yours.
7. **Chains:** you choose them. Follow [Add a chain](OPERATORS.md#add-a-chain) for each one, with your own portals.
8. **Deploy:** follow [DEPLOY.md](DEPLOY.md) with `solana program deploy` of a new program instead of the upgrade steps, then `npm run init`, `init_seat` and `init_extra`; `arm_keeper` only once your keeper runs continuously (an always-on loop that anchors every bet within 3 minutes), because a keeper bond posted while no keeper runs can be drained at no cost.
9. **Portals:** deploy your own `MoonForgePortal` contracts. Never reuse another instance's portals: their burns are credited by that instance's oracle.

Run all tests (`cargo test -p moon-forge --lib`, `bash tests/run-local.sh`, `npx hardhat test`, `cd oracle && npm test`) after any change.
