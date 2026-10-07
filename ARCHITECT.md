# Architect compensation

The person who designed and built Moon Forge (the "architect", wallet `7PuG8ELKXzvZqVLawFnmjDJqq4KEyRhssKQEq7aQM6Qd`) is paid **only** from optional activities, never from the burn path and never from a player's stake beyond the disclosed house edge and rakes.

| Source | Architect share | Who pays |
|---|---|---|
| Burn → claim → vesting → eject, Forge Drops | **0** | — |
| Donations, Be the House | **0** | — |
| House games (Coin Flip, High-Low, Void Rush) | 0.5% of each stake — one quarter of the 2% house edge already built into the odds | the house edge |
| Jackpot, Artifact Duel | 0.5% of the pot, only when someone wins | the 2% rake |
| Burn Lottery tickets | 0.5% of every ticket, at purchase | the 2% ticket fee |
| Artifact forging | 5% of the forge price, again on every re-forge after recycling | the NFT buyer |
| Artifact secondary sales | 5% royalty declared on the Core collection (paid only by marketplaces that honor it) | the NFT buyer |

All of these are compile-time constants in [`programs/moon-forge/src/constants.rs`](programs/moon-forge/src/constants.rs) and are shown on the Transparency page with live totals (`stats.to_architect`). If paying a cut would leave the architect wallet below the rent-exempt minimum, that cut goes to the reward pool instead.

Why NFTs and the house edge: they are optional, priced up-front, and recyclable — every forge creates value for the reward pool (40%) and the lottery (5%), so the architect earns only when the protocol is used, in proportion to that use.

**Transfers to the architect address:** until the v2 upgrade they are upgrade funding — the leftover after the upgrade is donated on-chain to the reward pool (see [docs/SUPPORT.md](docs/SUPPORT.md)). After the upgrade they are voluntary tips to the architect, not to the pool. To support burners instead, use **Donate → Reward pool**.

**Powers:** the architect has exactly one privileged action in the program: publishing the Genesis airdrop list once (`set_airdrop_root`). Separately, during the public test period the same wallet holds the program **upgrade authority**, which can replace the program (including these constants) until it is burned — see [SECURITY.md](SECURITY.md#upgrade-authority).
