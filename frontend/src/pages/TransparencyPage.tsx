/**
 * Moon Forge - Transparency Page
 *
 * Full protocol transparency: fee flows, immutable rules, referrer program,
 * fork guide, DevEscrow mechanics, and NFT recycling.
 *
 * Every claim on this page is verifiable on-chain.
 * Source code: github.com/moon-forge-dao/protocol
 */

import { ExternalLink, Lock, Unlock, RefreshCw, Coins, Users, GitFork, Shield, Zap, FlaskConical } from 'lucide-react';
import { TIERS, ARTIFACT_TIERS, PROJECT_LINKS } from '../lib/constants';

export default function TransparencyPage() {
    return (
        <div className="max-w-4xl mx-auto space-y-12 pb-16">

            {/* Header */}
            <section className="text-center py-8">
                <div className="flex items-center justify-center gap-3 mb-4">
                    <Shield className="w-8 h-8 text-forge-gold" />
                    <h1 className="font-space text-4xl font-black text-white">Protocol Transparency</h1>
                </div>
                <p className="text-lunar-400 max-w-2xl mx-auto">
                    Every fee, every rule, every wallet — visible on-chain.
                    This page reflects exactly what the verified smart contract bytecode enforces.
                    No promises. Just code.
                </p>
                <a
                    href={PROJECT_LINKS.contracts}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-2 mt-4 text-forge-orange hover:text-forge-gold transition-colors text-sm"
                >
                    <ExternalLink className="w-4 h-4" />
                    Verify contracts on GitHub
                </a>
            </section>

            {/* ─── WHAT IS IMMUTABLE ─── */}
            <Section icon={<Lock className="w-5 h-5 text-green-400" />} title="What No One Can Ever Change" accent="green">
                <p className="text-lunar-400 text-sm mb-6">
                    These values are compiled into the bytecode and verified on-chain.
                    Not the dev. Not the community. Not a fork of the code. No one.
                </p>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <ImmutableCard title="Fee Percentages (Early-Exit Penalties)">
                        <FeeRow label="Reward Pool (with referrer)" value="93.5%" highlight />
                        <FeeRow label="Reward Pool (no referrer)" value="95.5%" highlight />
                        <FeeRow label="Oracle Gas" value="1.0%" />
                        <FeeRow label="Referrer" value="2.0%" />
                        <FeeRow label="Architect (Dev)" value="2.0%" />
                        <FeeRow label="Dev Escrow (community incentive)" value="1.5%" />
                        <p className="text-xs text-lunar-500 mt-3">Source: Anchor program <code className="text-lunar-300">moon_forge_games</code> — <code>const BPS</code> values compiled into bytecode</p>
                    </ImmutableCard>

                    <ImmutableCard title="Mission Tiers">
                        {TIERS.map(t => (
                            <div key={t.id} className="flex justify-between items-center py-1.5 border-b border-white/5 last:border-0">
                                <span className="text-sm">{t.icon} {t.name}</span>
                                <span className="text-xs text-lunar-400">{t.duration}d · {t.multiplier}x · {t.penalty}% penalty</span>
                            </div>
                        ))}
                        <p className="text-xs text-lunar-500 mt-3">Source: Anchor program — <code className="text-lunar-300">TIER_*_DURATION</code> and <code>TIER_*_PENALTY_BPS</code> constants</p>
                    </ImmutableCard>

                    <ImmutableCard title="NFT Artifact Tiers (Phase 2)">
                        {ARTIFACT_TIERS.map(t => (
                            <div key={t.tier} className="flex justify-between items-center py-1.5 border-b border-white/5 last:border-0">
                                <span className="text-sm">{t.name}</span>
                                <span className="text-xs text-lunar-400">{t.basePrice} XNT base · +{t.boost}% boost</span>
                            </div>
                        ))}
                        <p className="text-xs text-lunar-500 mt-3">Artifact boosts active in Phase 2 (MoonArtifacts program). Phase 1: nft_boost_bps = 0.</p>
                    </ImmutableCard>

                    <ImmutableCard title="Architect Wallet (X1 SVM)">
                        <p className="text-sm text-lunar-300 mb-2">
                            <code className="text-forge-gold">state.architect: Pubkey</code>
                        </p>
                        <p className="text-xs text-lunar-400">
                            Set once via <code>initialize_protocol()</code> and never changed.
                            Compiled into the on-chain <code>ProtocolState</code> PDA.
                            Any fork that calls <code>initialize_protocol()</code> with a different pubkey
                            routes all architect fees to that address — fully verifiable on-chain.
                        </p>
                        <p className="text-xs text-lunar-500 mt-3">Source: Anchor program — <code className="text-lunar-300">ProtocolState.architect</code> field</p>
                    </ImmutableCard>
                </div>
            </Section>

            {/* ─── FEE FLOW ─── */}
            <Section icon={<Coins className="w-5 h-5 text-forge-gold" />} title="Fee Flows — Where Every XNT Goes" accent="gold">
                <p className="text-lunar-400 text-sm mb-6">
                    Fees are only applied to <strong className="text-white">early-exit penalties</strong>.
                    Normal deposits and donations have <strong className="text-green-400">zero fees</strong>.
                </p>

                <FlowBlock title="Early Exit Penalty (eject_pilot)" note="Applied to the unvested portion only — the principal (minus penalty) is returned to the user immediately">
                    <FlowRow label="Reward Pool" pct="93.5%" color="text-green-400" note="(95.5% if no referrer — those 2% go to pool, not to dev)" />
                    <FlowRow label="Oracle Gas" pct="1.0%" color="text-blue-400" note="covers oracle infrastructure; oracle auto-donates excess above 25 XNT ceiling back to pool" />
                    <FlowRow label="Referrer" pct="2.0%" color="text-purple-400" note="0 if no referrer — pool gets the extra 2%" />
                    <FlowRow label="Architect (Dev)" pct="2.0%" color="text-forge-orange" note="immutable X1 pubkey — symmetric with referrer" />
                    <FlowRow label="Dev Escrow" pct="1.5%" color="text-forge-gold" note="held 4 epochs — 100% returns to pool if volume grows ≥95%; stays locked if not" />
                    <div className="border-t border-white/10 mt-3 pt-2 flex justify-between text-xs text-lunar-500">
                        <span>TOTAL</span><span>100%</span>
                    </div>
                </FlowBlock>

                <FlowBlock title="NFT Artifact Purchase (Phase 2)" note="Dynamic price per NFT tier; price rises +5% per sale, decays -5% per 7 days (floor = base price)">
                    <FlowRow label="Reward Pool" pct="95.5%" color="text-green-400" />
                    <FlowRow label="Oracle Gas" pct="1.0%" color="text-blue-400" note="auto-donated to pool when oracle balance exceeds 25 XNT" />
                    <FlowRow label="Referrer" pct="2.0%" color="text-purple-400" note="0 if no referrer" />
                    <FlowRow label="Architect" pct="1.5%" color="text-forge-orange" note="intentionally lower than penalty split — NFT revenue favours the pool" />
                </FlowBlock>

                <FlowBlock title="Donations" note="via donate() in MoonForgeBase">
                    <FlowRow label="Reward Pool" pct="100%" color="text-green-400" note="zero fees guaranteed in code — event Donated emitted on-chain for verification" />
                </FlowBlock>

                <FlowBlock title="Game House Edge" note="all MoonGameBase subclasses">
                    <FlowRow label="Reward Pool" pct="100%" color="text-green-400" note="100% of house edge sent to vault via _distributeFees(). Games fuel the pool." />
                </FlowBlock>
            </Section>

            {/* ─── DEV ESCROW ─── */}
            <Section icon={<RefreshCw className="w-5 h-5 text-forge-gold" />} title="Dev Escrow — The Community Incentive Cycle" accent="gold">
                <p className="text-lunar-400 text-sm mb-6">
                    The 1.5% dev escrow is not a dev bonus — it's a trustless mechanism to align dev incentives
                    with platform growth. Every 4 epochs, anyone can call <code className="text-forge-gold">release_dev_escrow()</code>.
                </p>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
                    <div className="glass-card border border-green-500/30">
                        <div className="flex items-center gap-2 mb-3">
                            <div className="w-2 h-2 rounded-full bg-green-400" />
                            <h4 className="font-space text-sm text-green-400">Goal Met (≥95% of previous cycle)</h4>
                        </div>
                        <ul className="space-y-2 text-sm text-lunar-300">
                            <li>→ <strong className="text-green-400">100%</strong> of escrow balance → Reward Pool</li>
                            <li className="text-lunar-500 text-xs">Protocol grew: the entire 1.5% returns to community pilots</li>
                            <li className="text-lunar-500 text-xs">Dev receives nothing from escrow — only the 2% architect share</li>
                        </ul>
                    </div>
                    <div className="glass-card border border-forge-orange/30">
                        <div className="flex items-center gap-2 mb-3">
                            <div className="w-2 h-2 rounded-full bg-forge-orange" />
                            <h4 className="font-space text-sm text-forge-orange">Goal Missed (&lt;95% of previous cycle)</h4>
                        </div>
                        <ul className="space-y-2 text-sm text-lunar-300">
                            <li>→ Escrow <strong className="text-forge-orange">stays locked</strong> — nothing is released</li>
                            <li>→ Accumulates into the next 4-epoch cycle</li>
                            <li className="text-lunar-500 text-xs">Protocol stagnation: dev gets nothing. Escrow waits for the next growth window.</li>
                        </ul>
                    </div>
                </div>

                <InfoBox>
                    <strong>Goal metric is trustless.</strong> The cycle volume is tracked via <code>ProtocolState.cycle_volume</code> —
                    incremented on-chain each time a pilot calls <code>claim_and_start_mission()</code>.
                    No oracle input. No dev control. Anyone can verify the numbers and anyone can trigger
                    <code> release_dev_escrow()</code> — it's a permissionless instruction.
                </InfoBox>
            </Section>

            {/* ─── NFT RECYCLING ─── */}
            <Section icon={<RefreshCw className="w-5 h-5 text-blue-400" />} title="NFT Recycling Flywheel" accent="blue">
                <p className="text-lunar-400 text-sm mb-4">
                    Artifacts are not consumed — they circulate. This is a core protocol rule, not a feature.
                </p>
                <div className="space-y-3">
                    <Step n="1" label="User buys NFT from pool" detail="Pays current dynamic price. Price rises +5% for next buyer. Revenue: 95.5% to pool." />
                    <Step n="2" label="User equips and starts mission" detail="NFT is locked in MoonForgeBase vault for the mission duration." />
                    <Step n="3" label="Mission ends (complete or early exit)" detail="NFT is automatically restocked via restockArtifact() — returned to the market pool." />
                    <Step n="4" label="Price decays while waiting" detail="Each 7 days without a sale, price decays ~4.76% (÷1.05). Floor = base price. Never below." />
                    <Step n="5" label="Next user buys" detail="Cycle repeats. Every purchase generates pool revenue. Every lock removes supply temporarily, creating scarcity." />
                </div>
                <InfoBox className="mt-4">
                    <strong>No NFT is ever burned or permanently removed.</strong> The total supply is always 1,000.
                    They circulate between: active missions (locked), market pool (for sale), and users (equipped but unlocked).
                </InfoBox>
            </Section>

            {/* ─── REFERRER PROGRAM ─── */}
            <Section icon={<Users className="w-5 h-5 text-purple-400" />} title="Referrer Program" accent="purple">
                <p className="text-lunar-400 text-sm mb-4">
                    Referrers are wallets that bring new pilots. They earn automatically — no registration, no approval.
                </p>
                <div className="space-y-3 mb-4">
                    <RuleRow icon="✅" text="Earn exactly 2% of every penalty paid by users you referred (early exits)" />
                    <RuleRow icon="✅" text="Earn exactly 2% of every NFT sold using your referrer address" />
                    <RuleRow icon="✅" text="Payments are immediate — no claim required, sent on the same transaction" />
                    <RuleRow icon="✅" text="No registration needed — just use any wallet address as referrer parameter" />
                    <RuleRow icon="⛔" text="Cannot change any protocol parameters, fees, or contract logic" />
                    <RuleRow icon="⛔" text="Cannot intercept or delay payments to other parties" />
                    <RuleRow icon="⛔" text="Earn 0% if users complete missions patiently (no penalty = no referrer share)" />
                    <RuleRow icon="⛔" text="Self-referral blocked at contract level" />
                </div>
                <InfoBox>
                    Referrer share of 2% is identical to the dev share — intentionally symmetric.
                    A successful referrer earns the same percentage as the developer. Transparent and fair.
                </InfoBox>
            </Section>

            {/* ─── FORK GUIDE ─── */}
            <Section icon={<GitFork className="w-5 h-5 text-forge-orange" />} title="Forking the Protocol" accent="orange">
                <p className="text-lunar-400 text-sm mb-4">
                    Moon Forge is open-source. Forks are welcome. Here is exactly what a fork inherits and what it doesn't.
                </p>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
                    <div className="glass-card border border-green-500/20">
                        <h4 className="text-green-400 text-sm font-bold mb-3">Fork inherits (free to use)</h4>
                        <ul className="space-y-2 text-xs text-lunar-300">
                            <li>✅ All protocol logic — vesting, Merkle proof, epochs</li>
                            <li>✅ NFT recycling mechanics</li>
                            <li>✅ DevEscrow community cycle</li>
                            <li>✅ CWF fairness formula</li>
                            <li>✅ Game contracts (MoonGameBase + all games)</li>
                            <li>✅ Oracle off-chain scripts</li>
                        </ul>
                    </div>
                    <div className="glass-card border border-red-500/20">
                        <h4 className="text-red-400 text-sm font-bold mb-3">Fork does NOT inherit</h4>
                        <ul className="space-y-2 text-xs text-lunar-300">
                            <li>⛔ DEV_WALLET — hardcoded constant in <code>DevEscrow.sol</code></li>
                            <li>⛔ architectWallet — immutable in <code>MoonArtifacts.sol</code></li>
                            <li>⛔ devWallet — immutable in <code>MoonForgeBase.sol</code></li>
                            <li>⛔ Community trust of the original verified contract</li>
                            <li>⛔ Protocol history, reputation, and burn record</li>
                        </ul>
                        <p className="text-xs text-lunar-500 mt-3">
                            A fork that does not change <code>DEV_WALLET</code> before compiling will always
                            route fees to the original creator. This is intentional fork protection.
                        </p>
                    </div>
                </div>

                <InfoBox>
                    <strong>New games are the encouraged fork path.</strong> Any developer can deploy
                    a new game instruction that draws from <code>bankroll_vault</code> and routes losses
                    to <code>reward_vault</code> — games fuel burner rewards. The Anchor program's
                    game instructions (coin_flip, number_guess, jackpot) are fully open-source
                    templates. Fork, extend, and ship.
                </InfoBox>
            </Section>

            {/* ─── WHAT ADMIN CAN/CANNOT DO ─── */}
            <Section icon={<Unlock className="w-5 h-5 text-lunar-400" />} title="Community Admin — What Is Governable" accent="gray">
                <p className="text-lunar-400 text-sm mb-4">
                    After the dev transfers ownership to the community, these are the only levers available.
                    Everything else is hardcoded.
                </p>

                <div className="space-y-2 mb-4">
                    <RuleRow icon="🔑" text="Update oracle wallet — in case oracle infrastructure needs migration" />
                    <RuleRow icon="🔑" text="Update NFT metadata URI — to improve artwork or move to permanent IPFS" />
                    <RuleRow icon="🔑" text="Pause / unpause games — emergency protection only" />
                    <RuleRow icon="🔑" text="Set vault in new game deployments — connecting new games to the pool" />
                    <RuleRow icon="⛔" text="Cannot change fee percentages — all are public constants" />
                    <RuleRow icon="⛔" text="Cannot change dev, architect, or escrow wallet addresses — immutable" />
                    <RuleRow icon="⛔" text="Cannot redirect NFT revenues — vault locked after pool init" />
                    <RuleRow icon="⛔" text="Cannot swap NFT contract — artifacts locked after first set" />
                    <RuleRow icon="⛔" text="Cannot change tier durations, penalties, or NFT base prices" />
                    <RuleRow icon="⛔" text="Cannot drain the pool — only vested claims and legitimate payouts" />
                </div>

                <InfoBox>
                    <strong>DevEscrow has zero admin surface after launch.</strong>
                    Owner calls <code>setVault()</code> once, then <code>renounceOwnership()</code>.
                    After that, <code>settleCycle()</code> is permissionless — anyone can trigger it.
                </InfoBox>
            </Section>

            {/* ─── END-TO-END SIMULATION ─── */}
            <Section icon={<FlaskConical className="w-5 h-5 text-forge-gold" />} title="Live Example — Where Every XNT Goes" accent="gold">
                <p className="text-lunar-400 text-sm mb-6">
                    A complete worked simulation with real numbers: 5 pilots, 5 chains, early exits, games,
                    oracle ceiling, and DevEscrow. Every XNT is accounted for — nothing leaks, nothing is created.
                </p>

                <div className="space-y-4">
                    {/* Setup */}
                    <SimBlock title="Initial State">
                        <SimRow label="reward_vault (XNT pool)" value="200,000 XNT" color="text-green-400" />
                        <SimRow label="bankroll_vault (games — separate)" value="10,000 XNT" color="text-blue-400" />
                        <SimRow label="dev_escrow_vault" value="0 XNT" color="text-lunar-400" />
                        <p className="text-xs text-lunar-500 mt-2">The bankroll is completely separate from pilot missions. Games never touch vesting balances.</p>
                    </SimBlock>

                    {/* Epoch 1 burns */}
                    <SimBlock title="Epoch 1 — Five Pilots Burn XEN">
                        <div className="overflow-x-auto">
                            <table className="w-full text-xs text-left">
                                <thead>
                                    <tr className="text-lunar-500 border-b border-white/10">
                                        <th className="py-1 pr-3">Pilot</th><th className="py-1 pr-3">Chain</th>
                                        <th className="py-1 pr-3">XEN × CWF</th><th className="py-1 pr-3">Tier</th>
                                        <th className="py-1">XNT Allocated</th>
                                    </tr>
                                </thead>
                                <tbody className="text-lunar-300">
                                    <tr className="border-b border-white/5"><td className="py-1.5 pr-3">Alice</td><td className="pr-3">ETH (CWF 1.0)</td><td className="pr-3">1,000,000</td><td className="pr-3">🌙 180d</td><td className="text-green-400 font-bold">36,950 XNT</td></tr>
                                    <tr className="border-b border-white/5"><td className="py-1.5 pr-3">Bob</td><td className="pr-3">ETH (CWF 1.0)</td><td className="pr-3">500,000</td><td className="pr-3">🛸 45d</td><td className="text-green-400 font-bold">17,420 XNT</td></tr>
                                    <tr className="border-b border-white/5"><td className="py-1.5 pr-3">Carol</td><td className="pr-3">Polygon (CWF 0.01)</td><td className="pr-3">100,000</td><td className="pr-3">🌙 180d</td><td className="text-green-400 font-bold">10,620 XNT</td></tr>
                                    <tr className="border-b border-white/5"><td className="py-1.5 pr-3">Dave</td><td className="pr-3">BSC (CWF 0.045)</td><td className="pr-3">225,000</td><td className="pr-3">🚀 5d</td><td className="text-green-400 font-bold">5,310 XNT</td></tr>
                                    <tr><td className="py-1.5 pr-3">Eve</td><td className="pr-3">OP (CWF 0.88)</td><td className="pr-3">1,760,000</td><td className="pr-3">🛸 45d</td><td className="text-green-400 font-bold">29,700 XNT</td></tr>
                                </tbody>
                            </table>
                        </div>
                        <p className="text-xs text-lunar-500 mt-3">
                            Each pilot's XNT is transferred to their own <strong className="text-white">isolated VestingAccount PDA</strong> on X1.
                            Alice's XNT cannot touch Bob's — enforced cryptographically by the SVM runtime.
                            reward_vault: 200,000 → 100,000 XNT (100k locked in 5 isolated PDAs).
                        </p>
                    </SimBlock>

                    {/* Early exits */}
                    <SimBlock title="Bob Ejects Day 20 — Orbit, 20% Penalty, Has Referrer">
                        <SimRow label="Bob claimed (Day 15 linear vest)" value="5,807 XNT → Bob" color="text-green-400" />
                        <SimRow label="Remaining unvested" value="11,613 XNT" color="text-lunar-300" />
                        <SimRow label="Penalty (20%)" value="2,323 XNT distributed:" color="text-forge-orange" />
                        <div className="ml-4 space-y-0.5 my-1">
                            <SimRow label="  93.5% → Reward Pool" value="+ 2,172 XNT" color="text-green-400" />
                            <SimRow label="  2.0% → Referrer" value="46 XNT" color="text-purple-400" />
                            <SimRow label="  2.0% → Architect" value="46 XNT" color="text-forge-orange" />
                            <SimRow label="  1.5% → Dev Escrow" value="35 XNT" color="text-forge-gold" />
                            <SimRow label="  1.0% → Oracle" value="23 XNT" color="text-blue-400" />
                        </div>
                        <SimRow label="Bob returned" value="9,290 XNT + rent" color="text-green-400" />
                        <p className="text-xs text-lunar-500 mt-2">Total: 2,323 XNT = 100% ✓ — Bob's early exit <em>benefits</em> patient pilots.</p>
                    </SimBlock>

                    <SimBlock title="Carol Ejects Day 0 — Moon Landing, 50% Penalty, No Referrer">
                        <SimRow label="Penalty (50% of 10,620)" value="5,310 XNT distributed:" color="text-forge-orange" />
                        <div className="ml-4 space-y-0.5 my-1">
                            <SimRow label="  95.5% → Reward Pool" value="+ 5,071 XNT" color="text-green-400" />
                            <SimRow label="  2.0% → Architect" value="106 XNT" color="text-forge-orange" />
                            <SimRow label="  1.5% → Dev Escrow" value="80 XNT" color="text-forge-gold" />
                            <SimRow label="  1.0% → Oracle" value="53 XNT" color="text-blue-400" />
                            <SimRow label="  Referrer" value="0 XNT (no referrer → pool gets the extra 2%)" color="text-lunar-500" />
                        </div>
                        <SimRow label="Carol returned" value="5,310 XNT + rent" color="text-green-400" />
                        <p className="text-xs text-lunar-500 mt-2">Without referrer the pool always gets 95.5% — those 2% are never pocketed by dev.</p>
                    </SimBlock>

                    {/* Games */}
                    <SimBlock title="Eve Plays Games (Bankroll Fully Separate from Missions)">
                        <p className="text-xs text-lunar-400 mb-2">Eve has 29,700 XNT vesting — her mission is untouched. Games use only bankroll_vault.</p>
                        <SimRow label="Coin Flip WIN (1.96×, 100 XNT bet)" value="Eve receives 196 XNT from bankroll" color="text-green-400" />
                        <SimRow label="Coin Flip LOSE (100 XNT bet)" value="50 XNT → pool (subsidy) · 2 XNT → architect · 48 XNT → bankroll" color="text-forge-orange" />
                        <SimRow label="Jackpot WIN (~1.95%, 10×, 10 XNT bet)" value="Eve receives 100 XNT from bankroll" color="text-green-400" />
                        <p className="text-xs text-lunar-500 mt-2">Every game loss sends 50% of the loss to the reward pool — games continuously fund burner rewards.</p>
                    </SimBlock>

                    {/* Oracle ceiling */}
                    <SimBlock title="Oracle Ceiling — Auto-Donates Excess to Pool">
                        <SimRow label="Oracle wallet balance (after 7 epochs)" value="101 XNT accumulated" color="text-lunar-300" />
                        <SimRow label="Ceiling threshold" value="25 XNT" color="text-blue-400" />
                        <SimRow label="Excess detected" value="76 XNT → donate() → reward_vault" color="text-green-400" />
                        <SimRow label="Oracle wallet after" value="25 XNT (stays at ceiling)" color="text-blue-400" />
                        <p className="text-xs text-lunar-500 mt-2">The oracle never hoards. Excess always returns to pilots automatically.</p>
                    </SimBlock>

                    {/* DevEscrow */}
                    <SimBlock title="DevEscrow After 4 Epochs">
                        <SimRow label="Accumulated escrow (1.5% of all penalties)" value="~215 XNT" color="text-forge-gold" />
                        <SimRow label="Cycle 1 volume (Epochs 1–4)" value="380,000 XNT burned" color="text-lunar-300" />
                        <SimRow label="Cycle 2 volume (Epochs 5–8)" value="350,000 XNT — below 95% threshold" color="text-forge-orange" />
                        <SimRow label="release_dev_escrow() result" value="LOCKED — dev gets nothing" color="text-forge-orange" />
                        <SimRow label="Cycle 3 volume (Epochs 9–12)" value="410,000 XNT — above 95% threshold ✓" color="text-green-400" />
                        <SimRow label="release_dev_escrow() result" value="215 XNT → reward_vault (100% to pilots)" color="text-green-400" />
                        <p className="text-xs text-lunar-500 mt-2">Protocol growth is the only release key. Dev gets nothing until the community grows the protocol.</p>
                    </SimBlock>

                    {/* Final balance */}
                    <SimBlock title="Final Pool Balance — Everything Accounted For">
                        <SimRow label="Started with" value="200,000 XNT" color="text-lunar-300" />
                        <SimRow label="After epoch 1 allocations (100k to VestingPDAs)" value="100,000 XNT" color="text-lunar-300" />
                        <SimRow label="Bob early-exit pool share" value="+ 2,172 XNT" color="text-green-400" />
                        <SimRow label="Carol early-exit pool share" value="+ 5,071 XNT" color="text-green-400" />
                        <SimRow label="Game losses subsidising pool" value="+ ~500 XNT" color="text-green-400" />
                        <SimRow label="Oracle ceiling donation" value="+ 76 XNT" color="text-green-400" />
                        <SimRow label="DevEscrow released (cycle 3)" value="+ 215 XNT" color="text-green-400" />
                        <SimRow label="Pool after all activity" value="~108,034 XNT" color="text-forge-gold" />
                        <p className="text-xs text-lunar-500 mt-2 font-bold">Pool grew — not shrank. Early exits, games, and oracle overflow all feed back to patient pilots.</p>
                    </SimBlock>
                </div>
            </Section>

            {/* ─── SMART CONTRACT ADDRESSES ─── */}
            <Section icon={<Zap className="w-5 h-5 text-forge-gold" />} title="Smart Contracts" accent="gold">
                <p className="text-lunar-400 text-sm mb-4">
                    All contracts deployed on X1 Blockchain (Chain ID: 202401) and EVM chains.
                    Addresses updated after deployment.
                </p>
                <div className="space-y-2">
                    <ContractRow name="MoonForgeBase (X1 Vault)" address="TBD after deploy" />
                    <ContractRow name="MoonArtifacts (X1 NFTs)" address="TBD after deploy" />
                    <ContractRow name="DevEscrow (X1)" address="TBD after deploy" />
                    <ContractRow name="MoonForgePortal — Ethereum" address="TBD after deploy" />
                    <ContractRow name="MoonForgePortal — Optimism" address="TBD after deploy" />
                    <ContractRow name="MoonForgePortal — BSC (Day 13)" address="TBD after deploy" />
                    <ContractRow name="MoonForgePortal — Polygon (Day 26)" address="TBD after deploy" />
                    <ContractRow name="MoonForgePortal — Avalanche (Day 26)" address="TBD after deploy" />
                </div>
                <InfoBox className="mt-4">
                    <strong>X1 runs the Solana Virtual Machine (SVM).</strong> To claim XNT on X1, install
                    the <a href="https://chromewebstore.google.com/detail/x1-wallet/kcfmcpdmlchhbikbogddmgopmjbflnae" target="_blank" rel="noopener" className="underline">X1 Wallet</a> (or Backpack).
                    Your X1 address is a <strong>Base58 Solana public key</strong> — it looks like
                    <code>7xLk17EQQ5...hs3eSVV</code> (32–44 chars). This is the address you provide as
                    <code>x1TargetAddress</code> when burning XEN on EVM chains. It is completely different
                    from your MetaMask 0x address.
                </InfoBox>
            </Section>

        </div>
    );
}

// ─── SUB-COMPONENTS ─────────────────────────────────────────────────────────

function Section({ icon, title, accent, children }: {
    icon: React.ReactNode;
    title: string;
    accent: string;
    children: React.ReactNode;
}) {
    const borderColor = {
        green: 'border-green-500/20',
        gold: 'border-forge-gold/20',
        blue: 'border-blue-500/20',
        purple: 'border-purple-500/20',
        orange: 'border-forge-orange/20',
        gray: 'border-white/10',
    }[accent] ?? 'border-white/10';

    return (
        <section className={`glass-card border ${borderColor}`}>
            <div className="flex items-center gap-3 mb-6">
                {icon}
                <h2 className="font-space text-xl font-bold text-white">{title}</h2>
            </div>
            {children}
        </section>
    );
}

function ImmutableCard({ title, children }: { title: string; children: React.ReactNode }) {
    return (
        <div className="bg-space-800/50 rounded-lg p-4 border border-green-500/10">
            <div className="flex items-center gap-2 mb-3">
                <Lock className="w-3 h-3 text-green-400" />
                <h4 className="text-sm font-bold text-green-400">{title}</h4>
            </div>
            {children}
        </div>
    );
}

function FeeRow({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
    return (
        <div className="flex justify-between items-center py-1 border-b border-white/5 last:border-0 text-xs">
            <span className="text-lunar-400">{label}</span>
            <span className={highlight ? 'text-green-400 font-bold' : 'text-white'}>{value}</span>
        </div>
    );
}

function FlowBlock({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
    return (
        <div className="mb-4 bg-space-800/40 rounded-lg p-4 border border-white/5">
            <h4 className="font-space text-sm font-bold text-white mb-1">{title}</h4>
            {note && <p className="text-xs text-lunar-500 mb-3">{note}</p>}
            <div className="space-y-1">{children}</div>
        </div>
    );
}

function FlowRow({ label, pct, color, note }: { label: string; pct: string; color: string; note?: string }) {
    return (
        <div className="flex items-start justify-between text-sm py-1">
            <div>
                <span className="text-lunar-300">{label}</span>
                {note && <p className="text-xs text-lunar-500 mt-0.5">{note}</p>}
            </div>
            <span className={`font-bold ml-4 flex-shrink-0 ${color}`}>{pct}</span>
        </div>
    );
}

function InfoBox({ children, className = '' }: { children: React.ReactNode; className?: string }) {
    return (
        <div className={`bg-forge-gold/5 border border-forge-gold/20 rounded-lg p-4 text-sm text-lunar-300 ${className}`}>
            {children}
        </div>
    );
}

function Step({ n, label, detail }: { n: string; label: string; detail: string }) {
    return (
        <div className="flex gap-4">
            <div className="w-7 h-7 rounded-full bg-gradient-to-r from-forge-orange to-forge-gold flex items-center justify-center text-space-900 font-bold text-sm flex-shrink-0 mt-0.5">
                {n}
            </div>
            <div>
                <p className="text-sm font-semibold text-white">{label}</p>
                <p className="text-xs text-lunar-400 mt-0.5">{detail}</p>
            </div>
        </div>
    );
}

function RuleRow({ icon, text }: { icon: string; text: string }) {
    return (
        <div className="flex items-start gap-3 text-sm py-1.5 border-b border-white/5 last:border-0">
            <span className="flex-shrink-0">{icon}</span>
            <span className="text-lunar-300">{text}</span>
        </div>
    );
}

function SimBlock({ title, children }: { title: string; children: React.ReactNode }) {
    return (
        <div className="bg-space-800/40 rounded-lg p-4 border border-white/5">
            <h4 className="font-space text-sm font-bold text-white mb-3">{title}</h4>
            <div className="space-y-1">{children}</div>
        </div>
    );
}

function SimRow({ label, value, color }: { label: string; value: string; color: string }) {
    return (
        <div className="flex items-start justify-between text-xs py-0.5 gap-4">
            <span className="text-lunar-400 flex-shrink-0">{label}</span>
            <span className={`font-mono text-right ${color}`}>{value}</span>
        </div>
    );
}

function ContractRow({ name, address }: { name: string; address: string }) {
    const isPending = address === 'TBD after deploy';
    return (
        <div className="flex items-center justify-between py-2 border-b border-white/5 last:border-0">
            <span className="text-sm text-lunar-300">{name}</span>
            <span className={`text-xs font-mono ${isPending ? 'text-lunar-500 italic' : 'text-forge-gold'}`}>
                {address}
            </span>
        </div>
    );
}
