/**
 * Whitepaper v2 — concise summary. The full text lives in docs/WHITEPAPER.md.
 */
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { BookOpen, ExternalLink } from 'lucide-react';
import { AIRDROP_MAX, ARTIFACTS, FORGE_SPLIT, P, SECONDARY_ROYALTY_PCT } from '../lib/protocol';
import { PROJECT_LINKS } from '../lib/constants';

function Section({ n, title, children }: { n: number; title: string; children: ReactNode }) {
    return (
        <section className="glass-card">
            <h2 className="font-space text-xl text-white mb-3"><span className="text-forge-orange mr-2">{n}.</span>{title}</h2>
            <div className="text-sm text-lunar-300 space-y-3 leading-relaxed">{children}</div>
        </section>
    );
}

export default function WhitepaperPage() {
    return (
        <div className="max-w-4xl mx-auto space-y-6">
            <div className="text-center mb-4">
                <h1 className="font-space text-4xl font-bold mb-2"><BookOpen className="inline w-8 h-8 text-forge-gold mr-2" />Whitepaper v2</h1>
                <p className="text-lunar-400">Any XEN, on any chain → XNT on X1. Zero protocol fees on the burn path. Verifiable by anyone.</p>
                <a href={PROJECT_LINKS.whitepaperMd} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-forge-orange hover:underline text-sm mt-2">
                    Full text: docs/WHITEPAPER.md <ExternalLink className="w-3 h-3" />
                </a>
            </div>

            <Section n={1} title="Problem">
                <p>
                    XEN lives on many EVM chains; X1 is an SVM chain whose token is XNT. XEN cannot be bridged to X1: reaching XNT means selling XEN,
                    bridging USD and buying through thin pools, which is expensive for small holders. XEN Prime takes Ethereum XEN only.
                    Moon Forge offers one path for seven chains (Ethereum, BSC, Polygon, Avalanche, Optimism, Base, PulseChain): burn XEN where it lives,
                    receive XNT on X1. Portals are live on Base and Optimism; the other chains follow as their portals are deployed.
                </p>
            </Section>

            <Section n={2} title="Flow">
                <ol className="list-decimal list-inside space-y-1">
                    <li><strong className="text-white">Burn</strong> on an EVM chain through MoonForgePortal v2 (live on Base and Optimism; no owner, fee, pause or upgrade). XEN's own burn runs; the portal emits MissionStarted with your tier and 32-byte X1 key.</li>
                    <li><strong className="text-white">Epoch</strong> (weekly, Sundays 00:00 UTC; the program requires ≥ {P.minEpochIntervalDays} days between epochs): the oracle reads final burns, values them, builds a Merkle tree and publishes epoch-N.json, the root and the rate cap on X1. The program computes the budget.</li>
                    <li><strong className="text-white">Claim</strong>: permissionless. When the keeper is running it usually submits Launchpad claims for you; XNT always goes to the key in the leaf. Vesting starts when the leaf is claimed; vested XNT is not pushed automatically: use "Withdraw vested" (anyone can push it).</li>
                </ol>
            </Section>

            <Section n={3} title="Scoring and payout">
                <pre className="text-xs font-mono bg-black/30 rounded-lg p-3 overflow-x-auto text-green-300">{`value(burn)  = XEN amount × burn-hour price of that chain's XEN (USD) × L / (L + V)
               L = XEN-side USD liquidity of the chain's eligible pools
               V = Σ spot value burned on that chain in the epoch
score        = Σ value × tier multiplier × (1 + best eligible Artifact boost)
base_score   = Σ value × tier multiplier                 (no boosts)
rate_cap     = ${P.rateCapK} × XNT-per-USD × base_score / total_score
               (supplied by the oracle, must be > 0; recomputed by the verifier)
budget       = min(${P.epochBudgetBps / 100}% of the FREE reward pool, total_score × rate_cap)   ← on-chain
share        = score × budget / total_score               (Forge Drops included)`}</pre>
                <p>
                    So an epoch pays at most {P.rateCapK}× / {P.rateCapK * 2}× / {P.rateCapK * 3}× the liquidity-adjusted market value burned (Launchpad / Orbit / Moon Landing),
                    Forge Drops included. Artifact boosts only shift shares between burners of the same epoch and never raise the total; a burner alone gains nothing from a boost.
                    Only the budget line is computed by the program; the oracle supplies the rate cap and the verifier recomputes it from the epoch file.
                </p>
                <p>
                    Linear in value: splitting a burn across wallets gives exactly the same total (the liquidity discount depends on the chain's total, not on the wallet).
                    After the discount, a dollar of BSC-XEN scores the same as a dollar of ETH-XEN.
                </p>
                <p>
                    Prices (<code className="text-forge-orange">oracle/src/pricing.ts</code>): only pools whose other token is a liquid quote asset on an explicit per-chain
                    allowlist (wrapped native token, USDC / USDT / DAI, WETH) count, for price and for liquidity. The price pool is the eligible pool with the largest
                    XEN-side liquidity (not volume); the burn price is the median of its hourly closes over the 24 h ending at the burn hour. Each chain's prices are clamped
                    to ±50% of the median of that chain's reference price over the last 4 epochs (first epoch of a chain: ±50% of the aggregator token price); the XNT
                    price is clamped to ±50% of the previous epoch's.
                </p>
                <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                        <thead><tr className="text-left text-lunar-400 border-b border-white/10"><th className="py-1 pr-3">Tier</th><th className="py-1 pr-3">Multiplier</th><th className="py-1 pr-3">Paid</th><th className="py-1">Eject early</th></tr></thead>
                        <tbody>
                            {P.tiers.map((t) => (
                                <tr key={t.id} className="border-b border-white/5">
                                    <td className="py-1 pr-3">{t.icon} {t.name}</td>
                                    <td className="py-1 pr-3">{t.multiplier}×</td>
                                    <td className="py-1 pr-3">{t.vestingDays ? `linear over ${t.vestingDays} days` : 'instantly'}</td>
                                    <td className="py-1">{t.penaltyPct ? `${t.penaltyPct}% penalty on the unvested part (→ pool)` : '—'}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
                <p>
                    Vesting starts when the leaf is claimed (by the player or a keeper). Ejecting at once pays 0.80× (Orbit) / 0.75× (Moon Landing) of the Launchpad
                    equivalent in XNT, up to ~0.92× / ~0.975× counting Forge Drops: always less than Launchpad.
                </p>
            </Section>

            <Section n={4} title="Budget rules">
                <ul className="list-disc list-inside space-y-1">
                    <li>Each epoch uses at most {P.epochBudgetBps / 100}% of the free reward pool and at most total_score × rate_cap; epochs are at least {P.minEpochIntervalDays} days apart.</li>
                    <li>The program refuses any claim that would exceed the epoch budget. Claims stay open {P.claimWindowDays} days; then the rest returns to the pool.</li>
                    <li>
                        Forge Drops: {P.dropBudgetPct}% of the epoch budget, capped at {P.maxDropsPerEpoch * P.dropBackingXnt} XNT ({P.maxDropsPerEpoch} × {P.dropBackingXnt} XNT),
                        is part of the budget (not extra) and is drawn as Lunar Dust whose floor is the drop value (≥ {P.dropBackingXnt} XNT). Forge Drops are paid to XEN burners as
                        part of their own epoch reward. Your chance = your expected drop value ÷ {P.dropBackingXnt} XNT (linear: splitting a burn never changes your expected drop value);
                        at or above {P.dropBackingXnt} XNT you always win and the whole value becomes the floor. The seed is the hash of the first block at or after the publish
                        slot + 4, sealed by anyone; if nobody seals within ~512 slots the drops are cancelled and the reserve returns to the pool. Luck overrun beyond the reserve
                        comes from the free pool, and winners beyond reserve + max(reserve, {P.dropLuckBufferXnt} XNT) are refused. If Lunar Dust is sold out (600 alive) the drop is
                        paid in XNT. A drop must be received within the epoch's {P.claimWindowDays}-day window. Recycle the Artifact for its floor at any time, or keep it for the boost,
                        chips and Duels.
                    </li>
                    <li>
                        Inflows (only real flows): donations, 1% of house-game stakes, 1% of P2P pots and lottery tickets, {FORGE_SPLIT.poolPct}% of Artifact forges, eject penalties,
                        unclaimed or expired epoch budgets, cancelled Forge Drops, expired lottery prizes, orphan-Artifact floors, the v1 sweep, and the architect's cut while its
                        wallet is below rent exemption. Outflows: epoch claims, Forge Drops and keeper tips.
                    </li>
                    <li>No token, no inflation, no promised return. If nobody funds the pool, burns earn nothing — the live pool is shown before you burn.</li>
                </ul>
            </Section>

            <Section n={5} title="Games and fairness">
                <p>
                    All XNT games are instructions of the program. A bet locks the stake and commits to the next slot; settlement (anyone can do it) computes
                    <code className="text-forge-orange"> keccak("MOONFORGE_RNG" ‖ slotHash ‖ bet ‖ seed) mod 10000</code>. The result is not known to the player or the protocol
                    when the stake is locked (the block producer of that slot could in theory influence it). A bet not settled within ~3 minutes counts as lost even if its
                    roll was a win (the site settles immediately; the keeper is a safety net), so nobody can skip a bad result.
                </p>
                <ul className="list-disc list-inside space-y-1">
                    <li>Coin Flip (1.96×), High-Low (1–95% chance, pays 0.98 / chance), Void Rush (1.05×–100×, chance = 98% / target).</li>
                    <li>
                        House edge {P.houseEdgePct}%: {P.edgeToPoolPct}% reward pool, {P.edgeToArchitectPct}% architect, {P.edgeToBankrollPct}% bankroll. A bet can win at most
                        {' '}{P.maxExposurePct}% of the free bankroll; all unsettled payouts together stay under {P.maxTotalExposurePct}% of the bankroll. Circuit breaker: if the
                        bankroll (net of LP deposits and withdrawals) has lost 10% since the start of the UTC day, new house bets are refused until the next day.
                    </li>
                    <li>
                        Jackpot: a round starts at the first entry and closes {P.jackpotMinutes} minutes later; a single-player round is fully refunded; {P.p2pRakePct}% rake only
                        when someone wins ({P.rakeToPoolPct}% pool, {P.rakeToArchitectPct}% architect, {P.rakeToDrawPct}% lottery). If nobody settles within ~3 minutes after the
                        draw, the whole round is refunded entry by entry, never re-drawn.
                    </li>
                    <li>
                        Artifact Duel: a live Artifact of any tier is the ticket to the arena (checked when creating and when joining). The element you play is free (any of the 4),
                        hidden by commit-reveal, and not tied to the Artifacts you hold. Lunar beats Void, Void beats Solar, Solar beats Cosmic, Cosmic beats Lunar; the same or the
                        opposite element (Lunar–Solar, Cosmic–Void) is a draw with a full refund and no rake. The creator must reveal within 1 h or the opponent wins.
                        {' '}{P.p2pRakePct}% rake on wins.
                    </li>
                    <li>
                        Burn Lottery: a round lasts {P.drawDays} days from its first entry; weight = chips + {P.ticketPrice}-XNT tickets. Each ticket pays {P.p2pRakePct}% at purchase
                        ({P.rakeToPoolPct}% pool, {P.rakeToArchitectPct}% architect, {P.rakeToDrawPct}% back to the vault), so 98.5% of each ticket goes to the prize vault; the winner
                        gets {P.drawPrizePct}% of the vault. If nobody settles in time there is no winner: the would-be prize goes to the burners' reward pool (never carried over,
                        never re-drawn), and that round's chips and tickets are spent.
                    </li>
                    <li>
                        Chips: 1 per XNT actually received from burns (Launchpad at claim; Orbit / Moon Landing as vested XNT is withdrawn or at eject, never on the part lost to a
                        penalty), 1 per {P.chipPerWageredXnt} XNT wagered in house games, and weekly per Artifact ({ARTIFACTS.map((a) => a.weeklyChips).join(' / ')}); weeks reset on
                        Thursdays 00:00 UTC and missed weeks do not accumulate.
                    </li>
                    <li>
                        Be the House: deposit into the bankroll, share its edge and its variance; you can lose part of your deposit if players win. Shares are priced against the
                        house both ways (deposits as if every pending bet loses, withdrawals as if every pending bet wins) with a 1% slippage limit in the app. Withdrawals have a
                        {' '}{P.houseWithdrawHours} h cooldown and are priced when you withdraw, not when you request; a new request replaces the old one and restarts the timer.
                    </li>
                    <li>
                        Jackpot, Burn Lottery and Duels can only be entered by the wallet owner. Session keys (bots) play house games only and can never withdraw.
                    </li>
                    <li>Moon Wars is free practice only. Predictions are not implemented (X1 has no manipulation-resistant price feed yet).</li>
                </ul>
            </Section>

            <Section n={6} title="Artifacts (Metaplex Core NFTs)">
                <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                        <thead><tr className="text-left text-lunar-400 border-b border-white/10"><th className="py-1 pr-3">Tier</th><th className="py-1 pr-3">Max alive</th><th className="py-1 pr-3">Base price</th><th className="py-1 pr-3">Boost</th><th className="py-1">Weekly chips</th></tr></thead>
                        <tbody>
                            {ARTIFACTS.map((a) => (
                                <tr key={a.tier} className="border-b border-white/5">
                                    <td className="py-1 pr-3">{a.name} ({a.element})</td><td className="py-1 pr-3">{a.supply}</td><td className="py-1 pr-3">{a.price} XNT</td><td className="py-1 pr-3">+{a.boostPct}%</td><td className="py-1">{a.weeklyChips}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
                <p>
                    Forge split of the price actually paid: {FORGE_SPLIT.floorPct}% floor kept inside the NFT (returned on recycle), {FORGE_SPLIT.poolPct}% reward pool,
                    {' '}{FORGE_SPLIT.drawPct}% lottery, {FORGE_SPLIT.architectPct}% architect. Lunar Dust has a fixed price of {ARTIFACTS[0].price} XNT. Cosmic Shard / Solar Core /
                    Void Anomaly start at a base of {ARTIFACTS[1].price} / {ARTIFACTS[2].price} / {ARTIFACTS[3].price} XNT, rise 5% per forge and fall ÷1.05 (−4.76%) per full week
                    without a forge, never below base and never above 100× base. The buyer signs a maximum price, so a price move can only make the transaction fail, never cost more.
                </p>
                <p>
                    Floors by origin: forged = half of the price paid; Lunar Dust from a Forge Drop = the drop value (≥ {P.dropBackingXnt} XNT); Genesis airdrop = none.
                    Recycling returns the floor and frees the supply slot; it does not change the price. Supplies are caps on Artifacts alive at the same time.
                    A {SECONDARY_ROYALTY_PCT}% royalty is declared for secondary sales (paid where marketplaces honor it).
                </p>
                <p>
                    Boost: only an Artifact held by the same owner at both the previous and the current epoch snapshot counts (no flash forging or renting for the snapshot),
                    and only the best one per wallet. It shifts shares between burners of the same epoch and never raises the total.
                </p>
                <p>
                    Genesis airdrop: up to {AIRDROP_MAX} Lunar Dust with no floor. The current list is a draft of 444 validator withdraw authorities and will be rebuilt to add
                    Genesis supporters before the architect calls <code className="text-forge-orange">set_airdrop_root</code> (one time, final). Only the first {AIRDROP_MAX} claims
                    succeed; the claimant pays the account rent and needs a free Lunar Dust slot. Artifacts do not exist on-chain until minted; the collection is created by
                    {' '}<code className="text-forge-orange">init_artifacts</code> after the upgrade.
                </p>
            </Section>

            <Section n={7} title="Fees">
                <p>
                    Burn → claim → vesting: <strong className="text-green-400">0%</strong>. The architect's only income: {P.edgeToArchitectPct}% of house-game stakes,
                    {' '}{P.rakeToArchitectPct}% of Jackpot / Duel pots when someone wins and of every lottery ticket, {FORGE_SPLIT.architectPct}% of forge prices, and a
                    {' '}{SECONDARY_ROYALTY_PCT}% royalty on secondary sales where honored. Nothing from burns, claims or Forge Drops; if the architect wallet would stay below
                    rent exemption, its cut goes to the reward pool. Keeper tips are paid by the pool, never by the player: {P.keeperTip} XNT per claim of ≥ {P.keeperTipMinClaim} XNT
                    submitted for someone else, and {P.dropKeeperTip} XNT per Forge Drop delivered for someone else. All are compile-time constants, listed on the
                    {' '}<Link to="/transparency" className="text-forge-orange hover:underline">Transparency</Link> page.
                </p>
            </Section>

            <Section n={8} title="Trust assumptions">
                <ul className="list-disc list-inside space-y-1">
                    <li>
                        <strong className="text-white">Oracle</strong>: can only publish epoch roots with their rate cap (and hand its role to a new key). Each epoch is bounded by
                        {' '}{P.epochBudgetBps / 100}% of the free pool and by total_score × rate_cap, at least {P.minEpochIntervalDays} days apart, with every input published and
                        hash-committed so anyone can recompute it. A dishonest oracle could still direct up to that budget to false burns; the verifier would show the mismatch.
                    </li>
                    <li><strong className="text-white">Upgrade authority</strong>: held by the architect wallet during the public test period, to be burned afterwards. Until then it can replace the program code. Its live value is on the Transparency page.</li>
                    <li><strong className="text-white">Keeper</strong>: permissionless; anyone can run it; it only triggers outcomes already determined. Runs can be delayed.</li>
                    <li><strong className="text-white">Architect key</strong>: its only privileged program action is setting the airdrop root once.</li>
                    <li><strong className="text-white">Session keys</strong>: house games only; they can never withdraw or enter Jackpot, Burn Lottery or Duels.</li>
                    <li><strong className="text-white">EVM portals</strong>: live on Base and Optimism (other chains to follow); no owner, fee, pause or upgrade.</li>
                </ul>
            </Section>

            <Section n={9} title="Risks">
                <ul className="list-disc list-inside space-y-1">
                    <li>Burns are irreversible; XNT payouts are never promised and depend on the pool and on how many burners share each epoch.</li>
                    <li>The oracle could report false burns (bounded as above); prices can be wrong (clamped to ±50% of recent reference prices).</li>
                    <li>
                        Smart-contract bugs: the code is open and was tested locally (unit tests, integration against the real Metaplex Core, a randomized solvency stress test,
                        internal adversarial reviews that are not independent), but there has been no third-party audit. The program is upgradeable during the test period.
                    </li>
                    <li>The block producer of a bet's slot could in theory influence its result (each bet can win at most {P.maxExposurePct}% of the free bankroll). Be the House deposits can lose value when players win. XNT is volatile.</li>
                </ul>
            </Section>
        </div>
    );
}
