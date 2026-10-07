# Moon Forge oracle v2

Reads final `MissionStarted` burns from the EVM portals, values them at market price with a liquidity discount, builds one Merkle tree per epoch, publishes the root and the epoch `rate_cap` on X1 (the program applies `budget = min(10% of the free pool, total_score × rate_cap)` itself), auto-claims for burners and runs the permissionless keeper. Every epoch file can be re-verified by anyone, including the `rate_cap`.

```bash
npm install
npm test                                   # unit tests (no network)
npm run verify -- ../frontend/public/epochs/epoch-1.json --full   # anyone
npm run epoch -- --dry                     # build without publishing
npm run epoch                              # oracle key only
npm run keeper                             # any funded key
npm run init                               # one-time v2 setup after the program upgrade
```

| File | Role |
|---|---|
| `src/config.ts` | chains, portals, finality depths, payout policy (K = 1.25) |
| `src/evm.ts` | final-block log reader (abort instead of skip, dedup) |
| `src/pricing.ts` | XEN prices per chain (GeckoTerminal): only pools quoted in an allowlisted liquid asset (wrapped native, USDC/USDT/DAI, WETH); price pool = deepest eligible pool by XEN-side liquidity; burn price = median of its hourly closes over the 24 h ending at the burn hour; clamped to ±50% of the chain's 4-epoch median reference. XNT price (x1report / XDEX), clamped to ±50% of the previous epoch's |
| `src/epoch.ts` | pure scoring, tree, canonical data hash, verification |
| `src/merkle.ts` | sorted-pair keccak tree, identical to the program's verifier |
| `src/x1.ts` | Anchor client, Artifact snapshot, publish, claims, keeper |
| `src/index.ts` | CLI |

Operations guide: [../OPERATORS.md](../OPERATORS.md).
