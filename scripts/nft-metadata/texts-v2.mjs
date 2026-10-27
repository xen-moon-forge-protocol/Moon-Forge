// v2 texts: the copy served today by GitHub Pages under /nft/, which is what the LIVE program's METADATA_BASE_URI
// points at (program tag program-2026-10-12). They describe the v2 rules and stay byte-identical until the final
// upgrade; never upload them to Arweave (the void 2026-10-14 manifest rdVTds... already holds them).
// The permanent texts are in texts-final.mjs.
import { SITE, SYMBOL, COLLECTION_NAME, TIERS, title } from './tiers.mjs';

const V2 = {
  lunar_dust: { price: 10, boost: 5, chips: 5 },
  cosmic_shard: { price: 25, boost: 10, chips: 15 },
  solar_core: { price: 60, boost: 20, chips: 40 },
  void_anomaly: { price: 200, boost: 50, chips: 150 },
};

export function buildV2({ imageBase, imageExt }) {
  const imageType = imageExt === 'webp' ? 'image/webp' : 'image/jpeg';
  const files = {};
  files['collection.json'] = {
    name: COLLECTION_NAME,
    symbol: SYMBOL,
    description: 'Recyclable utility NFTs of Moon Forge Protocol on X1. Each Artifact raises its holder\'s share of an epoch\'s burn rewards (only if held by the same owner at two consecutive epoch snapshots; best Artifact per wallet; the epoch total never changes), grants weekly Burn Lottery chips, is a ticket to Artifact Duel (the element played is chosen freely and hidden) and to Moon Wars real-XNT matches, and holds a refundable XNT floor (except Genesis airdrop Lunar Dust). Recycle it through Moon Forge at any time to get the floor back. Lunar Dust is also drawn among XEN burners as Forge Drops, paid to them as part of their own epoch reward. Utilities are implemented by the program 57UE1U1t23ztg2noLp8pcpGW1B1Xw25rLH6ra9Mchea9 and the public epoch oracle, and readable by any project.',
    image: `${imageBase}/void_anomaly/event_horizon.${imageExt}`,
    external_url: `${SITE}/artifacts`,
  };
  for (const tier of TIERS) {
    const t = { ...tier, ...V2[tier.slug] };
    t.variants.forEach((v, i) => {
      const image = `${imageBase}/${t.slug}/${v}.${imageExt}`;
      files[`${t.slug}/${i}.json`] = {
        name: `${t.name} — ${title(v)}`,
        symbol: SYMBOL,
        description:
          `${t.lore}\n\n` +
          `UTILITY (Moon Forge program + oracle):\n` +
          `• +${t.boost}% XEN burn score for the holder — counts only if held by the same owner at two consecutive epoch snapshots; best Artifact per wallet; it shifts shares within an epoch and never raises the epoch total\n` +
          `• ${t.chips} Burn Lottery chips every week (claim_artifact_chips; weeks reset Thursdays 00:00 UTC, missed weeks do not accumulate)\n` +
          `• Ticket to Artifact Duel: any live Artifact lets its holder create or join duels; the element played is chosen freely and hidden by commit-reveal\n` +
          `• Ticket to Moon Wars: any live Artifact lets its holder create or join real-XNT card matches\n` +
          (t.slug === 'lunar_dust'
            ? `• Refundable floor: 5 XNT when forged; the drop value (at least 5 XNT) when won as a Forge Drop; none for Genesis airdrop Lunar Dust — recycle to get it back. `
            : `• Refundable floor: half of the price its buyer paid (${t.price / 2} XNT at the base price) — recycle to get it back. `) +
          `The exact floor of each Artifact is its on-chain "Floor XNT" attribute\n` +
          `• Max ${t.supply} alive at any time; recycling frees the slot for a new forge\n` +
          (t.slug === 'lunar_dust'
            ? `• Also drawn among XEN burners as Forge Drops: 10% of each epoch budget (at most 100 XNT), paid to XEN burners as part of their epoch reward, as Lunar Dust holding a floor of at least 5 XNT\n\n`
            : `\n`) +
          (t.slug === 'lunar_dust'
            ? `Forge price ${t.price} XNT (fixed): 50% floor, 40% burners' reward pool, 5% Burn Lottery, 5% architect; 5% royalty on secondary sales where honored.`
            : `Base forge price ${t.price} XNT, +5% with every forge and ÷1.05 (-4.76%) per full week without one (never below base, never above 100× base); the buyer signs a max price. ` +
              `Of the price paid: 50% floor, 40% burners' reward pool, 5% Burn Lottery, 5% architect; 5% royalty on secondary sales where honored.`),
        image,
        external_url: `${SITE}/artifacts`,
        attributes: [
          { trait_type: 'Tier', value: t.name },
          { trait_type: 'Variant', value: title(v) },
          { trait_type: 'Element', value: t.element },
          { trait_type: 'Duel Ticket', value: 'Yes' },
          { trait_type: 'Moon Wars Ticket', value: 'Yes' },
          { trait_type: 'Burn Boost', value: `+${t.boost}%` },
          { trait_type: 'Weekly Chips', value: t.chips },
          { trait_type: 'Max Alive', value: t.supply },
          { trait_type: 'Recyclable', value: 'Yes' },
        ],
        properties: { category: 'image', files: [{ uri: image, type: imageType }] },
      };
    });
  }
  return files;
}
