# How to fork and re-deploy Moon Forge

MIT licensed. To launch your own instance with different parameters:

1. **Program id:** generate a keypair (`solana-keygen new -o target/deploy/moon_forge-keypair.json`), put its address in `declare_id!` (`programs/moon-forge/src/lib.rs`) and `Anchor.toml`.
2. **Identities & economics:** edit `programs/moon-forge/src/constants.rs` — `ARCHITECT`, `INITIAL_ORACLE`, fees, tiers, budgets, NFT prices, `METADATA_BASE_URI`. Keep the `localnet` test identities for testing.
3. **Clients:** rebuild the IDL (`anchor idl build`) and copy it to `oracle/src/idl/` and `frontend/src/idl/`; update `ARCHITECT` in `frontend/src/lib/protocol.ts` and `oracle/src/x1.ts`, `GITHUB_URL` / Vite `base` in the frontend, and `SITE` in `scripts/nft-metadata/generate-metadata.mjs`.
4. **Deploy:** follow [DEPLOY.md](DEPLOY.md) (`solana program deploy` instead of the upgrade steps, then `npm run init`).
5. **Portals:** deploy your own `MoonForgePortal` contracts; never reuse another instance's portals (their burns are credited by that instance's oracle).

Run all tests (`cargo test`, `tests/run-local.sh`, `npx hardhat test`, `oracle npm test`) after any parameter change.
