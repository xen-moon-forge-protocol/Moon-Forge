# Moon Forge Artifacts

**Dated status (2026-10-22).** This page describes the Artifact rules live today (program tag `program-2026-10-12`, "v2"). Several utilities below are v2-only and end on announced dates: read the [notice](#notice-2026-10-22-what-changes-for-artifacts-and-genesis) before forging or claiming. From 2026-10-23 the site pauses forging and the Genesis claim until the final upgrade; the program still accepts both through other clients, under today's v2 attribute texts ([README, Interim notice](../README.md#interim-notice-2026-10-22)). The floor mechanism (half of the forge price kept inside the NFT, recoverable by recycling) does not change. As of 2026-10-22 no Artifact has been minted on mainnet (0 records) and 0 of the 120 Genesis claims have been made.

Metaplex Core NFTs, collection `7Re1n5DsnvyJnDTiaaZZ1f9G9REPRwb2Br7SYVYCfpzK` (PDA `["collection"]` of program `57UE1U1t23ztg2noLp8pcpGW1B1Xw25rLH6ra9Mchea9`), update authority = program PDA `["artifact_authority"]` (`5BHQBgoTjUMhwkzTKtcgZPQEuwWkEcrRNZERNcm9Nzx1`, no human key; the program itself is upgradeable until its authority is burned, see [SECURITY.md](../SECURITY.md)). An asset outside this collection is not a Moon Forge Artifact, whatever its name or image. Royalty plugin on the collection: 5% to the architect on secondary sales, paid only where marketplaces honor it.

## Tiers (v2, live today)

| Tier | Max alive | Base price | Pricing | Floor | Burn boost *(v2)* | Weekly chips *(v2)* | Variants |
|---|---|---|---|---|---|---|---|
| 0 Lunar Dust | 600 | 10 XNT | fixed | 5 XNT when forged; the drop value (≥ 5 XNT) from a Forge Drop; none from the Genesis airdrop | +5% | 5 | Frost Blue, Golden Dust, Lavender Mist, Rose Quartz, Sage Green, Silver Moon |
| 1 Cosmic Shard | 300 | 25 XNT | dynamic | half of the price paid | +10% | 15 | Amethyst, Aquamarine, Magenta Pulse |
| 2 Solar Core | 90 | 60 XNT | dynamic | half of the price paid | +20% | 40 | Flame, Red Giant |
| 3 Void Anomaly | 10 | 200 XNT | dynamic | half of the price paid | +50% | 150 | Event Horizon |

Dynamic price (`artifacts.rs::current_price / next_price`): +5% per forge; ÷1.05 (−4.76%) per full week without a forge; never below the base price, never above 100× it. The buyer signs `max_price`, so a price move can only make the transaction fail, never charge more. Recycling does not change the price.

"Max alive": a cap on Artifacts alive at the same time. Recycling frees a slot, which can be forged again. Asset addresses are PDAs `["asset", tier, serial]`; serials only grow.

## Notice (2026-10-22): what changes for Artifacts and Genesis

Decided on 2026-10-20/22, not live. Published before the first Genesis claim and before the first forge, so nobody acts on an outdated promise.

| What | Today (v2) | Decided | From |
|---|---|---|---|
| Burn boost | +5 / 10 / 20 / 50% by tier, held at two consecutive snapshots | none: the v3 oracle rules carry no Artifact boost | the switch to v3 (first v3 epoch; date announced at least one full epoch ahead with the last v2 publish transaction) |
| Weekly chips | 5 / 15 / 40 / 150 per week per Artifact | zero, from every source; existing chips stay inert and are disclosed as such | the final program upgrade (planned November 2026, announced ≥ 7 days ahead; if it is not deployed by 2026-12-31 the upgrade authority is burned on the then-current binary with the games delisted, [IMMUTABILITY.md](../IMMUTABILITY.md#when-the-upgrade-authority-will-be-burned)) |
| Arena ticket | a live Artifact of any tier is required for Duels and Moon Wars | no ticket; nothing in Moon Forge requires an Artifact | the final upgrade |
| Forge Drops | 10% of each epoch budget as Lunar Dust | end; drops already won stay claimable within their 90-day window | the final upgrade |
| Floor | half of the forge price, recoverable by recycling | unchanged | — |
| Genesis Lunar Dust | free, no floor, otherwise a normal Lunar Dust | a free collectible of the official collection with a cosmetic holder badge; no floor, no boost, no chips, no ticket, nothing to claim from it; recycling gives back only the account rent; not needed to play, burn or claim | boost at the switch, chips and ticket at the final upgrade; the claim stays open at least until 2026-12-31: the live program closes it on 2026-12-31 (00:00 UTC 2027-01-01), and the final upgrade plans to extend it to 2027-03-31 by the length of the pause, announced before 2027-01-01 |
| Forge price split, and what a forged Artifact does after the upgrade | 50% floor / 40% pool / 5% lottery / 5% architect | published in the upgrade announcement and in a rewritten version of this page at least 7 days before the upgrade; until then only v2 applies | the final upgrade |

The on-chain `Burn Boost` and `Weekly Chips` attributes of an Artifact minted today describe v2 and stop describing anything after those dates ([META-2](KNOWN-ISSUES.md#artifacts-and-metadata)).

## Lifecycle (v2)

- **Forge** (`forge_artifact(tier, serial, max_price)`): the price paid is split 50% floor (kept in the `ArtifactRecord` PDA) / 40% reward pool / 5% Burn Lottery / 5% architect. (The 5% forge cut is not a royalty; the royalty is the separate 5% on secondary sales.)
- **Recycle** (`recycle_artifact`): the holder burns the NFT through Moon Forge and receives the floor + record rent; the slot is freed.
- **Forge Drops** (`claim_drop`, *v2*): 10% of every epoch budget (at most 100 XNT) is drawn among that epoch's XEN burners as Lunar Dust, part of their own epoch reward, not extra. Each leaf's expected drop value is its share of that reserve; it wins with probability (value ÷ 5 XNT), and at or above 5 XNT it always wins and the whole value becomes the floor. Odds are linear (splitting never changes your expected drop value) and use the hash of the first block at or after the publish slot + 4, sealed permissionlessly; if nobody seals within ~512 slots the drops are cancelled and the reserve goes back to the pool. The producer of that block can influence the hash ([GAM-1](KNOWN-ISSUES.md#games)). Origin "Forge Drop". If 600 Lunar Dust are alive, `claim_drop_xnt` pays the same value in XNT. A drop must be received within the epoch's 90-day window (anyone can deliver it; the Artifact always goes to the player in the leaf). See the whitepaper, section 3.1.
- **Orphans** (`reclaim_orphan`): if an Artifact is burned outside Moon Forge, anyone can send its floor to the reward pool and free the slot.
- **Chips** (`claim_artifact_chips`, *v2*): once per week per Artifact, by its current holder: 5 / 15 / 40 / 150 by tier. Weeks are `unix time / 604800`, so they reset on Thursdays 00:00 UTC; a missed week does not accumulate.
- **Boost** (*v2*): at each epoch the oracle snapshots live holders. Only an Artifact held by the **same owner at both the previous and the current epoch snapshot** counts (no flash forging or renting for the snapshot; in the first epoch no boost applies), and only the best one per wallet. A boost raises your share of that epoch, never the epoch total: a burner alone gains nothing from it.
- **Duel and Moon Wars ticket** (*v2*): holding a live Artifact of **any** tier is the ticket to the Duel arena and to Moon Wars (checked when creating and when joining). The element you play in a Duel is free (any of the four), chosen per duel and hidden by commit-reveal; it does not depend on which Artifacts you hold. Lunar > Void > Solar > Cosmic > Lunar; same or opposite element = draw. Open issues of both arenas: [GAM-4 to GAM-6](KNOWN-ISSUES.md#games).

## On-chain attributes (readable by any project)

Each asset carries a Core `Attributes` plugin: `Tier`, `Element` (thematic, tied to the tier; Duel elements are chosen freely), `Burn Boost` (*v2*), `Weekly Chips` (*v2*), `Floor XNT`, `Origin` (Forged / Genesis Airdrop / Forge Drop), `Serial`, `Recyclable`. Other X1 projects can grant utility to holders by reading the asset owner and these attributes, or the `ArtifactRecord` PDA. To check that an asset is genuine, check that it belongs to the collection above and that its `ArtifactRecord` PDA exists.

## Metadata

Each Artifact's metadata lives at `<METADATA_BASE_URI><tier_slug>/<variant>.json` (variant = serial % variants), plus `collection.json`, where `METADATA_BASE_URI` is a program constant. **Today it is the site's GitHub Pages folder `/nft/`.** A permanent copy is being prepared on **Arweave** (pay-once storage with no account behind it); the final program upgrade will point `METADATA_BASE_URI` and the collection at it. The upload record is [`deployments/nft-arweave.json`](../deployments/nft-arweave.json); its JSON (v2 utility texts) will not be used, its images are reused only if every file serves from the chosen gateway with a matching hash (otherwise re-uploaded), and `arweave.net` did not serve all of its paths when checked while other gateways did ([META-1](KNOWN-ISSUES.md#artifacts-and-metadata)). The final texts are re-uploaded and checked for 7 days on two gateways before the gateway is compiled in.

- Images: 1024×1024 WebP built from the source art by `scripts/nft-metadata/build-webp.py` (kept in `nft-arweave/images/`), each under ArDrive Turbo's free upload limit. The source art, like the branding images, was made with an AI image tool from the project's own prompts and then edited; generator metadata was removed from the published files.
- JSON: `scripts/nft-metadata/generate-metadata.mjs`. The upload (images first, then the JSON pointing at them) is done by `scripts/nft-metadata/upload-arweave.mjs` from the `NFT metadata to Arweave` workflow, signed by a throwaway key created inside the run.
- After the upgrade, the collection is pointed at the same folder by `refresh_collection_uri`, which anyone can call and which can only write the compiled constant.
- The GitHub Pages copy under `/nft/` stays online for the site.

Names and URIs are written on-chain at mint time by the program (`{Tier} #{serial+1}`, URI as above), so the JSON describes the variant artwork and the on-chain `Attributes` plugin carries the per-asset facts (exact floor, origin, serial).

Artifacts do not exist before someone mints them: the collection was created once by `init_artifacts`, and each Artifact is created when it is forged, airdropped or dropped. "Max alive" is a cap, not a pre-minted stock.

## Genesis airdrop

Up to 120 Lunar Dust without floor, claimable at least until 31 December 2026: the live program closes the claim on 2026-12-31 (00:00 UTC, 1 January 2027), and the final upgrade plans to extend it to 2027-03-31 by the length of the pause, announced before 2027-01-01. Whatever is unclaimed at the deadline is never minted, so every Lunar Dust slot stays available for forging. The architect published the list once (`set_airdrop_root`, one time; final under the live program, which has no instruction to change it); each listed wallet claims with its Merkle proof from `frontend/public/airdrop/airdrop.json` (built by `scripts/airdrop/build-airdrop.mjs`). Only the first 120 claims succeed; the claimant pays the account rent, and a Lunar Dust slot must be free. Leaf = `keccak("MOONFORGE_V2_AIRDROP" ‖ wallet)`.

**Status: published on-chain on 2026-10-12** (`set_airdrop_root`, transaction `2k9UyuQNgNqB1uY9dtkkGdLiqeymxGcDthtYdofZecV687Y6CBzVwkadYxcGsAsDRatdc6E56GvrFgVjzfEWtofF`, root `ec3e6ae5bba79664bc86c77d3ad8a9b2e7e20b233adeb7a4686058f96019f171`; final under the live program, which has no instruction to change it). **0 of 120 claimed as of 2026-10-22.** The list contains the 444 unique withdraw authorities of active X1 vote accounts on 2026-10-07 (the people who run X1 validators), excluding foundation-scale validators. No outside supporter qualified at publication, and nothing sent now changes the list (see [SUPPORT.md](SUPPORT.md#genesis-airdrop-published-final-under-the-live-program)). The lists were built from public data with these scripts (re-running them today gives a slightly different set, as validators join and leave; the published file is the one that counts):

```bash
node scripts/airdrop/collect-validators.mjs > validators.txt
node scripts/airdrop/collect-donors.mjs > donors.txt
cat donors.txt validators.txt > wallets.txt && node scripts/airdrop/build-airdrop.mjs wallets.txt
```

**What a Genesis Lunar Dust is**: see the [notice](#notice-2026-10-22-what-changes-for-artifacts-and-genesis) above, published before the first claim. In short: a free collectible of the official collection with a cosmetic holder badge; its v2 utilities end on the announced dates; it is not needed to play, burn or claim anything.

**Claiming safely.** The only claim page this project publishes is this site's Artifacts page (paused from 2026-10-23 until the final upgrade; the program still accepts claims through other clients, under today's v2 attribute texts), and the claimant must be the listed wallet itself (the program checks the signature against the leaf). If your listed wallet is a validator withdraw authority kept offline, do not import it into a browser extension just for this: a claim from a keypair file is planned for the agent kit well before the deadline, after which the Artifact can be transferred to any wallet. Moon Forge never contacts listed wallets first, by any channel: any message, DM, memo or link about "your Genesis claim" is not from the project. Before signing, check the program id and the site address against the [verify block](SUPPORT.md#verify-you-are-on-the-real-moon-forge).
