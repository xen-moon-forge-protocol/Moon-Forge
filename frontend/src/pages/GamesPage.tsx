/**
 * Moon Forge Games v2.0
 * 
 * 🎮 Complete Gaming Suite 🎮
 * 
 * Phase 1: Coin Flip, High-Low, Burn Lottery
 * Phase 2: Jackpot, Artifact Duel, Predictions
 */

import { useState } from 'react';
import { Coins, TrendingUp, TrendingDown, Ticket, Trophy, Flame, RefreshCw, Clock, Users, Info, Swords, BarChart3, Shield, Gamepad2, HelpCircle, Wallet } from 'lucide-react';
import { useWallet } from '../context/WalletContext';
import MoonWarsBattle from '../components/MoonWarsBattle';
import { GAME_CONTRACTS, GAME_FEES, GAME_CONFIG } from '../config/games';

type GameId = 'flip' | 'highlow' | 'lottery' | 'jackpot' | 'duel' | 'predictions' | 'wars' | 'void';

const CONTRACT_KEYS: Record<GameId, keyof typeof GAME_CONTRACTS> = {
    flip:        'COIN_FLIP',
    highlow:     'COIN_FLIP', // same MoonGames.sol contract
    lottery:     'LOTTERY',
    jackpot:     'JACKPOT',
    duel:        'DUEL',
    predictions: 'PREDICTIONS',
    wars:        'VOID_RUSH',  // Moon Wars uses same contract slot for now
    void:        'VOID_RUSH'
};

// ═══════════════════════════════════════════════════════════════════════════
//                              MAIN COMPONENT
// ═══════════════════════════════════════════════════════════════════════════

export default function GamesPage() {
    const { x1Connected, connectX1 } = useWallet();
    const [activeGame, setActiveGame] = useState<GameId>('flip');
    const [showRules, setShowRules] = useState(false);

    return (
        <div className="max-w-4xl mx-auto">
            {/* Header */}
            <div className="text-center mb-6">
                <h1 className="font-space text-4xl font-bold mb-2">
                    <span className="text-forge-gold">🎮</span> Moon Forge Games
                </h1>
                <p className="text-lunar-400">Play. Win. Fund the Pool.</p>
            </div>

            {/* RNG Disclaimer */}
            <div className="mb-4 p-3 bg-amber-500/10 border border-amber-500/30 rounded-xl flex items-start gap-3 text-xs text-lunar-300">
                <Info className="w-4 h-4 text-amber-400 flex-shrink-0 mt-0.5" />
                <div>
                    <strong className="text-amber-300">Fair Play Notice:</strong> All game outcomes use on-chain pseudo-randomness
                    (<span className="font-mono text-amber-200">keccak256(block.prevrandao, timestamp, sender)</span>).
                    Suitable for X1 testnet / beta. A Chainlink VRF integration is planned before high-value mainnet deployment.
                    Never bet more than you can afford to lose.
                </div>
            </div>

            {/* Pool Flywheel Banner */}
            <div className="mb-6 p-4 bg-forge-gold/10 border border-forge-gold/20 rounded-xl flex items-center gap-4">
                <Flame className="w-8 h-8 text-forge-orange flex-shrink-0" />
                <div className="flex-1 text-sm">
                    <span className="text-white font-semibold">How games fund XNT burners: </span>
                    <span className="text-lunar-300">
                        Every house edge (2–5%) goes directly to the XNT Reward Pool — the same pool that pays out XEN burners.
                        The more games played, the higher the APY for long-term holders.
                    </span>
                </div>
                <div className="text-right text-xs text-lunar-400 flex-shrink-0">
                    <div>Flip: 3.5%</div>
                    <div>H-Low: 4%</div>
                    <div>Lottery: 20% burn</div>
                </div>
            </div>

            {/* Game Selector - 3 rows */}
            <div className="glass-card mb-6 p-4">
                <div className="grid md:grid-cols-2 gap-6">
                    <div>
                        <div className="text-xs text-lunar-500 mb-2 uppercase tracking-wide font-bold">Quick & Arcade</div>
                        <div className="flex flex-wrap gap-2">
                            <GameTab id="flip" label="Coin Flip" icon={<Coins className="w-4 h-4" />} active={activeGame === 'flip'} onClick={() => setActiveGame('flip')} />
                            <GameTab id="highlow" label="High-Low" icon={<TrendingUp className="w-4 h-4" />} active={activeGame === 'highlow'} onClick={() => setActiveGame('highlow')} />
                            <GameTab id="void" label="Void Rush" icon={<Shield className="w-4 h-4" />} active={activeGame === 'void'} onClick={() => setActiveGame('void')} badge="CRASH" />
                            <GameTab id="jackpot" label="Jackpot" icon={<Users className="w-4 h-4" />} active={activeGame === 'jackpot'} onClick={() => setActiveGame('jackpot')} badge="MULTI" />
                        </div>
                    </div>
                    <div>
                        <div className="text-xs text-lunar-500 mb-2 uppercase tracking-wide font-bold">NFT & Strategy</div>
                        <div className="flex flex-wrap gap-2">
                            <GameTab id="duel" label="Artifact Duel" icon={<Swords className="w-4 h-4" />} active={activeGame === 'duel'} onClick={() => setActiveGame('duel')} badge="PVP" />
                            <GameTab id="predictions" label="Predictions" icon={<BarChart3 className="w-4 h-4" />} active={activeGame === 'predictions'} onClick={() => setActiveGame('predictions')} />
                            <GameTab id="lottery" label="Burn Lottery" icon={<Flame className="w-4 h-4" />} active={activeGame === 'lottery'} onClick={() => setActiveGame('lottery')} badge="WEEKLY" />
                            <GameTab id="wars" label="Moon Wars" icon={<Gamepad2 className="w-4 h-4" />} active={activeGame === 'wars'} onClick={() => setActiveGame('wars')} badge="TCG" />
                        </div>
                    </div>
                </div>
            </div>

            {/* Game Area */}
            <div className="glass-card relative">
                <div className="absolute top-4 right-4 z-10">
                    <button onClick={() => setShowRules(!showRules)} className="p-2 text-lunar-400 hover:text-white bg-space-800/50 rounded-lg" title="Game Rules">
                        <HelpCircle className="w-5 h-5" />
                    </button>
                </div>

                {showRules && (
                    <div className="mb-6 p-4 bg-mission-orbit/10 border border-mission-orbit/30 rounded-xl">
                        <h3 className="font-bold text-white mb-2 flex items-center gap-2"><Info className="w-4 h-4" /> How to Play</h3>
                        <GameRules game={activeGame} />
                    </div>
                )}

                {/* Liquidity Display */}
                <GameLiquidityDisplay game={activeGame} />

                {activeGame === 'flip' && <CoinFlipGame connected={x1Connected} onConnect={connectX1} />}
                {activeGame === 'highlow' && <HighLowGame connected={x1Connected} onConnect={connectX1} />}
                {activeGame === 'lottery' && <LotteryGame connected={x1Connected} onConnect={connectX1} />}
                {activeGame === 'jackpot' && <JackpotGame connected={x1Connected} onConnect={connectX1} />}
                {activeGame === 'duel' && <DuelGame connected={x1Connected} onConnect={connectX1} />}
                {activeGame === 'predictions' && <PredictionsGame connected={x1Connected} onConnect={connectX1} />}
                {activeGame === 'wars' && <MoonWarsBattle />}
                {activeGame === 'void' && <VoidRushGame connected={x1Connected} onConnect={connectX1} />}
            </div>

            {/* Info Footer */}
            <div className="mt-6 p-4 bg-space-700/50 rounded-xl text-center">
                <p className="text-lunar-400 text-sm flex items-center justify-center gap-2">
                    <Info className="w-4 h-4" />
                    All game fees go to the XNT Reward Pool — raising APY for XEN burners every time someone plays.
                </p>
            </div>
        </div>
    );
}

function GameLiquidityDisplay({ game }: { game: GameId }) {
    const key = CONTRACT_KEYS[game];
    const address = GAME_CONTRACTS[key];
    const isDeployed = address !== '0x0000000000000000000000000000000000000000';

    return (
        <div className="absolute top-4 left-4 flex items-center gap-2 text-xs text-lunar-500 bg-space-800/50 px-3 py-1.5 rounded-lg border border-white/5">
            <Wallet className="w-3 h-3 text-forge-gold" />
            <span>
                {isDeployed ? (
                    <>Contract: <span className="text-white font-mono">{address.slice(0, 6)}...{address.slice(-4)}</span></>
                ) : (
                    <span className="text-amber-400">Pre-launch — contract not deployed</span>
                )}
            </span>
        </div>
    );
}

const GAME_FEE_LABELS: Partial<Record<GameId, string>> = {
    flip:        '3.5% house edge → 100% to XNT Reward Pool',
    highlow:     '4% house edge → 100% to XNT Reward Pool',
    lottery:     '20% of prize pool permanently burned (dead address)',
    jackpot:     '5% of pot → 100% to XNT Reward Pool',
    duel:        '2.5% of pot → 100% to XNT Reward Pool',
    predictions: '2% of settled bets → 100% to XNT Reward Pool',
    void:        '2% house edge (probability skew) → 100% of losses to XNT Reward Pool',
};

function GameRules({ game }: { game: GameId }) {
    const feeLabel = GAME_FEE_LABELS[game] ?? 'Variable — see game info';

    return (
        <div className="grid md:grid-cols-2 gap-4 text-sm text-lunar-300">
            <div>
                <h4 className="text-white font-bold mb-1">Gameplay Rules & Fairness</h4>
                {game === 'duel' && <p><strong>Artifact Duel:</strong><br />Element cycle: Void &gt; Solar &gt; Cosmic &gt; Lunar &gt; Void.<br />Tie (same element) = both lose, pot goes to Reward Pool.<br />Commit-reveal scheme prevents front-running.</p>}
                {game === 'lottery' && <p><strong>XNT Burn Lottery:</strong> 10 XNT = 1 ticket. Weekly draw (7 days). <strong>80% of pool → winner</strong>, <strong>20% permanently burned</strong> (sent to dead address 0x…dEaD), reducing XNT supply forever. Pseudo-random winner selection on-chain.</p>}
                {game === 'wars' && <p><strong>Moon Wars TCG:</strong> 1v1 Strategy. NFTs = Stat Cards. Card draw uses on-chain RNG; outcome is skill-based. Training mode only — no rewards until main contract deployed.</p>}
                {game === 'predictions' && <p><strong>P2P Prediction Markets:</strong> Users create Yes/No markets. Bets matched peer-to-peer. Unmatched bets refunded. Oracle resolves outcomes. 2% fee on settled bets.</p>}
                {!['duel', 'lottery', 'wars', 'predictions'].includes(game) && <p>Provably fair: outcome determined by <span className="font-mono text-xs bg-space-600/50 px-1 rounded">keccak256(prevrandao, timestamp, sender)</span> at transaction time.</p>}
            </div>
            <div>
                <h4 className="text-white font-bold mb-1">Fee Routing</h4>
                <ul className="list-disc pl-4 space-y-1 text-xs">
                    <li><strong>Fee:</strong> <span className="text-forge-orange">{feeLabel}</span></li>
                    <li><strong>Flywheel:</strong> Fees → Reward Pool → APY for XEN burners.</li>
                    <li><strong>Real XNT:</strong> All games use real XNT. No play money.</li>
                    <li><strong>Contracts:</strong> Pre-launch. All balances will be live post-deploy.</li>
                </ul>
            </div>
        </div>
    );
}

// ═══════════════════════════════════════════════════════════════════════
//                              VOID RUSH (CRASH)
// ═══════════════════════════════════════════════════════════════════════════

function VoidRushGame({ connected, onConnect }: { connected: boolean; onConnect: () => void }) {
    const [betAmount, setBetAmount] = useState(GAME_CONFIG.VOID.tiers[0].toString());
    const [targetMult, setTargetMult] = useState("2.00");
    const [playing, setPlaying] = useState(false);
    const [result, setResult] = useState<{ won: boolean; crash: number; payout: number } | null>(null);
    const [currentScale, setCurrentScale] = useState(1.00);

    // Calc Probability
    const safeTarget = targetMult.replace(',', '.');
    const target = parseFloat(safeTarget) || 1.01;
    // Win Chance = (1/Target) * (1 - HouseEdge)
    // House Edge normally 0.02 (2%)? Using simplified view here
    const winChance = (100 / target) * 0.98;

    const play = async () => {
        if (!connected) {
            alert("Please connect your X1 Wallet to play.");
            return onConnect();
        }

        const safeBet = betAmount.replace(',', '.');
        const bet = parseFloat(safeBet);

        if (isNaN(bet) || bet < GAME_CONFIG.VOID.minBet || bet > GAME_CONFIG.VOID.maxBet) {
            return alert(`Bet must be between ${GAME_CONFIG.VOID.minBet} and ${GAME_CONFIG.VOID.maxBet}`);
        }
        if (target < 1.05 || target > 100) return alert("Target must be between 1.05x and 100x");

        try {
            setPlaying(true);
            setResult(null);
            setCurrentScale(1.00);

            // Simulate "Rush" animation
            // Rapidly count up to target or crash point
            const mockCrash = Math.random() > (winChance / 100)
                ? 1 + Math.random() * (target - 1)  // Loss: Crash before target
                : target + Math.random() * 2;       // Win: Crash after target

            // Animation Loop
            let scale = 1.00;
            const step = (mockCrash - 1) / 50; // 50 steps

            for (let i = 0; i < 50; i++) {
                await new Promise(r => setTimeout(r, 30)); // Fast ticks
                scale += step;
                setCurrentScale(scale);
            }
            setCurrentScale(mockCrash);

            // Result
            const won = mockCrash >= target;
            setResult({
                won,
                crash: mockCrash,
                payout: won ? bet * target : 0
            });

        } catch (err) {
            console.error("VoidRush Error:", err);
            alert("Transaction failed.");
        } finally {
            setPlaying(false);
        }
    };

    return (
        <div className="p-6 text-center">
            <h2 className="font-space text-2xl font-bold text-white mb-2">🚀 Void Rush</h2>
            <p className="text-lunar-400 mb-6">Instant Target Crash • Safety First</p>

            {/* Animation / Graph Area */}
            <div className={`relative h-48 mb-6 rounded-2xl border-2 flex items-center justify-center overflow-hidden transition-colors duration-300 ${result ? (result.won ? 'bg-green-500/10 border-green-500/50' : 'bg-red-500/10 border-red-500/50') : 'bg-space-800/50 border-space-600'
                }`}>

                <div className="text-center z-10">
                    <div className="text-lunar-400 text-xs uppercase tracking-widest mb-1">Current Multiplier</div>
                    <div className={`text-5xl font-mono font-bold ${result ? (result.won ? 'text-green-400' : 'text-red-500') : 'text-white'
                        }`}>
                        {currentScale.toFixed(2)}x
                    </div>
                    {result && (
                        <div className={`text-sm mt-2 font-bold ${result.won ? 'text-green-400' : 'text-red-400'}`}>
                            {result.won ? `EJECTED AT ${target.toFixed(2)}x` : 'CRASHED'}
                        </div>
                    )}
                </div>

                {/* Background Grid/Effect */}
                <div className="absolute inset-0 opacity-20 pointer-events-none"
                    style={{ backgroundImage: 'radial-gradient(circle, #4f46e5 1px, transparent 1px)', backgroundSize: '20px 20px' }}>
                </div>
            </div>

            <div className="grid grid-cols-2 gap-6 max-w-lg mx-auto">
                {/* Bet Input */}
                <div className="text-left">
                    <label className="text-xs text-lunar-400 mb-1 block">Bet Amount (XNT)</label>
                    <div className="flex gap-2 mb-2">
                        {GAME_CONFIG.VOID.tiers.slice(0, 3).map(t => (
                            <button key={t} onClick={() => setBetAmount(t.toString())} className="px-2 py-1 bg-space-600 text-xs rounded text-lunar-300 hover:text-white transition">{t}</button>
                        ))}
                    </div>
                    <input
                        type="number"
                        value={betAmount}
                        onChange={e => setBetAmount(e.target.value)}
                        className="w-full bg-space-800 border border-space-600 rounded-lg p-3 text-white focus:border-mission-orbit outline-none"
                    />
                </div>

                {/* Target Input */}
                <div className="text-left">
                    <label className="text-xs text-lunar-400 mb-1 block">Target Multiplier (x)</label>
                    <div className="flex gap-2 mb-2">
                        {[1.5, 2.0, 5.0].map(m => (
                            <button key={m} onClick={() => setTargetMult(m.toFixed(2))} className="px-2 py-1 bg-space-600 text-xs rounded text-lunar-300 hover:text-white transition">{m}x</button>
                        ))}
                    </div>
                    <input
                        type="number"
                        step="0.1"
                        value={targetMult}
                        onChange={e => setTargetMult(e.target.value)}
                        className="w-full bg-space-800 border border-space-600 rounded-lg p-3 text-white focus:border-mission-orbit outline-none"
                    />
                </div>
            </div>

            {/* Info Row */}
            <div className="flex justify-between items-center max-w-lg mx-auto mt-4 mb-6 text-xs text-lunar-400 px-2">
                <span>Win Chance: <strong className="text-white">{winChance.toFixed(2)}%</strong></span>
                <span>Potential Payout: <strong className="text-forge-gold">{(parseFloat(betAmount || "0") * parseFloat(targetMult || "0")).toFixed(2)} XNT</strong></span>
            </div>

            <button
                onClick={play}
                disabled={playing}
                className={`w-full max-w-lg py-4 rounded-xl font-bold text-lg shadow-lg transition-all ${playing ? 'bg-space-600 cursor-wait text-lunar-400' : 'bg-gradient-to-r from-mission-orbit to-purple-600 hover:brightness-110 text-white'
                    }`}
            >
                {playing ? 'FLYING...' : '🚀 LAUNCH MISSION'}
            </button>
        </div>
    );
}

// ═══════════════════════════════════════════════════════════════════════════
//                              GAME TAB
// ═══════════════════════════════════════════════════════════════════════════

function GameTab({ label, icon, active, onClick, badge }: {
    id?: string; label: string; icon: React.ReactNode; active: boolean; onClick: () => void; badge?: string;
}) {
    return (
        <button
            onClick={onClick}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg font-medium transition-all ${active
                ? 'bg-gradient-to-r from-forge-orange to-forge-gold text-white'
                : 'bg-space-600 text-lunar-400 hover:text-white'
                }`}
        >
            {icon}
            {label}
            {badge && <span className="text-[10px] px-1.5 py-0.5 bg-white/20 rounded uppercase">{badge}</span>}
        </button>
    );
}

// ═══════════════════════════════════════════════════════════════════════════
//                              COIN FLIP
// ═══════════════════════════════════════════════════════════════════════════

function CoinFlipGame({ connected, onConnect }: { connected: boolean; onConnect: () => void }) {
    const [betAmount, setBetAmount] = useState(GAME_CONFIG.COIN_FLIP.tiers[0].toString());
    const [playing, setPlaying] = useState(false);
    const [result, setResult] = useState<{ won: boolean; side: string; payout: number } | null>(null);
    const [animating, setAnimating] = useState(false);

    const play = async (guessHeads: boolean) => {
        if (!connected) {
            alert("Please connect your X1 Wallet to play.");
            return onConnect();
        }

        try {
            setPlaying(true);
            setResult(null);
            setAnimating(true);

            // Simulate flip animation
            await new Promise(r => setTimeout(r, 1500));

            // Mock result (will use contract implementation)
            const isHeads = Math.random() > 0.5;
            const won = guessHeads === isHeads;
            const bet = parseFloat(betAmount);

            // Use real fee from config
            const fee = GAME_FEES.COIN_FLIP; // 3.5%
            const multiplier = 2 * (1 - fee); // e.g. 1.93

            setAnimating(false);
            setResult({
                won,
                side: isHeads ? 'Heads' : 'Tails',
                payout: won ? bet * multiplier : 0
            });

            setPlaying(false);
        } catch (err) {
            console.error("CoinFlip Error:", err);
            alert("Transaction failed.");
        } finally {
            setPlaying(false);
            setAnimating(false);
        }
    };

    return (
        <div className="text-center p-6">
            <h2 className="font-space text-2xl font-bold text-white mb-2">🪙 Coin Flip</h2>
            <p className="text-lunar-400 mb-6">50/50 chance • {(2 * (1 - GAME_FEES.COIN_FLIP)).toFixed(2)}x payout</p>

            {/* Coin Animation Area */}
            <div className="w-32 h-32 mx-auto mb-6 relative">
                <div className={`w-full h-full rounded-full bg-gradient-to-br from-forge-gold to-amber-600 flex items-center justify-center text-4xl shadow-xl ${animating ? 'animate-spin' : ''}`}>
                    {result ? (result.side === 'Heads' ? '👑' : '🌙') : '🪙'}
                </div>
            </div>

            {/* Result */}
            {result && (
                <div className={`mb-6 p-4 rounded-xl ${result.won ? 'bg-green-500/20 border border-green-500/50' : 'bg-red-500/20 border border-red-500/50'}`}>
                    <div className={`text-2xl font-bold ${result.won ? 'text-green-400' : 'text-red-400'}`}>
                        {result.won ? '🎉 You Won!' : '😢 You Lost'}
                    </div>
                    <div className="text-lunar-300 text-sm">
                        Result: {result.side} {result.won && `• +${result.payout.toFixed(2)} XNT`}
                    </div>
                </div>
            )}

            {/* Bet Amount */}
            <div className="mb-6">
                <label className="text-lunar-400 text-sm mb-2 block">Bet Amount (XNT)</label>
                <div className="flex items-center justify-center gap-2">
                    {GAME_CONFIG.COIN_FLIP.tiers.map(amt => (
                        <button
                            key={amt}
                            onClick={() => setBetAmount(amt.toString())}
                            className={`px-3 py-1 rounded ${betAmount === amt.toString() ? 'bg-forge-orange text-white' : 'bg-space-600 text-lunar-400 hover:text-white'}`}
                        >
                            {amt}
                        </button>
                    ))}
                </div>
            </div>

            {/* Buttons */}
            <div className="flex gap-4 justify-center">
                <button
                    onClick={() => play(true)}
                    disabled={playing}
                    className="flex-1 max-w-[150px] py-3 bg-gradient-to-r from-amber-500 to-amber-600 text-white rounded-xl font-bold hover:opacity-90 disabled:opacity-50"
                >
                    {playing ? '...' : '👑 Heads'}
                </button>
                <button
                    onClick={() => play(false)}
                    disabled={playing}
                    className="flex-1 max-w-[150px] py-3 bg-gradient-to-r from-purple-500 to-purple-600 text-white rounded-xl font-bold hover:opacity-90 disabled:opacity-50"
                >
                    {playing ? '...' : '🌙 Tails'}
                </button>
            </div>

            {!connected && (
                <p className="text-amber-400 text-sm mt-4">Connect X1 wallet to play</p>
            )}
        </div>
    );
}

// ═══════════════════════════════════════════════════════════════════════════
//                              HIGH-LOW
// ═══════════════════════════════════════════════════════════════════════════

function HighLowGame({ connected, onConnect }: { connected: boolean; onConnect: () => void }) {
    const [currentNumber, setCurrentNumber] = useState(50);
    const [betAmount, setBetAmount] = useState(GAME_CONFIG.HIGH_LOW.tiers[0].toString());
    const [playing, setPlaying] = useState(false);
    const [result, setResult] = useState<{ won: boolean; newNum: number; payout: number } | null>(null);

    // Calculate multipliers with fee deduction
    const feeMod = 1 - GAME_FEES.HIGH_LOW;
    const highMultiplier = ((100 / (100 - currentNumber)) * feeMod).toFixed(2);
    const lowMultiplier = ((100 / (currentNumber - 1)) * feeMod).toFixed(2);

    const play = async (guessHigh: boolean) => {
        if (!connected) {
            alert("Please connect your X1 Wallet to play.");
            return onConnect();
        }

        try {
            setPlaying(true);
            setResult(null);

            await new Promise(r => setTimeout(r, 1000));

            const newNum = Math.floor(Math.random() * 100) + 1;
            const won = guessHigh ? newNum > currentNumber : newNum < currentNumber;
            const multiplier = guessHigh ? parseFloat(highMultiplier) : parseFloat(lowMultiplier);
            const bet = parseFloat(betAmount);

            setResult({
                won,
                newNum,
                payout: won ? bet * multiplier : 0
            });

            setCurrentNumber(newNum);
        } catch (err) {
            console.error("HighLow Error:", err);
            alert("Transaction error. Please try again.");
        } finally {
            setPlaying(false);
        }
    };

    return (
        <div className="text-center p-6">
            <h2 className="font-space text-2xl font-bold text-white mb-2">📊 High-Low</h2>
            <p className="text-lunar-400 mb-6">Will the next number be higher or lower?</p>

            {/* Current Number */}
            <div className="w-32 h-32 mx-auto mb-6 rounded-2xl bg-gradient-to-br from-mission-orbit to-purple-900 flex items-center justify-center">
                <span className="text-5xl font-bold text-white">{currentNumber}</span>
            </div>

            {/* Result */}
            {result && (
                <div className={`mb-6 p-4 rounded-xl ${result.won ? 'bg-green-500/20 border border-green-500/50' : 'bg-red-500/20 border border-red-500/50'}`}>
                    <div className={`text-2xl font-bold ${result.won ? 'text-green-400' : 'text-red-400'}`}>
                        {result.won ? '🎉 Correct!' : '😢 Wrong'}
                    </div>
                    <div className="text-lunar-300 text-sm">
                        New number: {result.newNum} {result.won && `• +${result.payout.toFixed(2)} XNT`}
                    </div>
                </div>
            )}

            {/* Bet Amount */}
            <div className="mb-6">
                <label className="text-lunar-400 text-sm mb-2 block">Bet Amount (XNT)</label>
                <div className="flex items-center justify-center gap-2">
                    {GAME_CONFIG.HIGH_LOW.tiers.map(amt => (
                        <button
                            key={amt}
                            onClick={() => setBetAmount(amt.toString())}
                            className={`px-3 py-1 rounded ${betAmount === amt.toString() ? 'bg-forge-orange text-white' : 'bg-space-600 text-lunar-400'}`}
                        >
                            {amt}
                        </button>
                    ))}
                </div>
            </div>

            {/* Buttons with Multipliers */}
            <div className="flex gap-4 justify-center">
                <button
                    onClick={() => play(false)}
                    disabled={playing || currentNumber <= 1}
                    className="flex-1 max-w-[180px] py-3 bg-gradient-to-r from-red-500 to-red-600 text-white rounded-xl font-bold hover:opacity-90 disabled:opacity-50"
                >
                    <TrendingDown className="w-4 h-4 inline mr-1" />
                    Lower ({lowMultiplier}x)
                </button>
                <button
                    onClick={() => play(true)}
                    disabled={playing || currentNumber >= 100}
                    className="flex-1 max-w-[180px] py-3 bg-gradient-to-r from-green-500 to-green-600 text-white rounded-xl font-bold hover:opacity-90 disabled:opacity-50"
                >
                    <TrendingUp className="w-4 h-4 inline mr-1" />
                    Higher ({highMultiplier}x)
                </button>
            </div>
        </div>
    );
}

// ═══════════════════════════════════════════════════════════════════════════
//                              LOTTERY
// ═══════════════════════════════════════════════════════════════════════════

function LotteryGame({ connected, onConnect }: { connected: boolean; onConnect: () => void }) {
    const [tickets, setTickets] = useState(1);
    const [buying, setBuying] = useState(false);
    const ticketPrice = GAME_CONFIG.LOTTERY.ticketPrice;

    const roundInfo = {
        roundId: 0,
        prizePool: 0,
        totalTickets: 0,
        timeRemaining: 'Waiting...',
        myTickets: 0
    };

    const lastWinner = null as { address: string; prize: number; round: number } | null;

    const buyTickets = async () => {
        if (!connected) {
            alert("Please connect your X1 Wallet to play.");
            return onConnect();
        }

        try {
            setBuying(true);
            await new Promise(r => setTimeout(r, 1500));
            alert(`Purchased ${tickets} ticket(s) for ${tickets * ticketPrice} XNT (burned)`);
        } catch (err) {
            console.error("Lottery Error:", err);
            alert("Failed to buy tickets.");
        } finally {
            setBuying(false);
        }
    };

    return (
        <div className="p-6">
            <div className="text-center mb-6">
                <h2 className="font-space text-2xl font-bold text-white mb-2">🔥 XNT Burn Lottery</h2>
                <p className="text-lunar-400">Burn XNT. Win big. Fund the pool.</p>
            </div>

            {/* Prize Pool */}
            <div className="bg-gradient-to-r from-forge-orange/20 to-amber-500/20 rounded-2xl p-6 mb-6 text-center">
                <div className="text-lunar-400 text-sm mb-1">Current Prize Pool</div>
                <div className="text-5xl font-bold text-forge-gold mb-2">{roundInfo.prizePool.toLocaleString()} XNT</div>
                <div className="flex justify-center gap-6 text-sm">
                    <span className="flex items-center gap-1 text-lunar-300">
                        <Ticket className="w-4 h-4" /> {roundInfo.totalTickets} tickets
                    </span>
                    <span className="flex items-center gap-1 text-lunar-300">
                        <Clock className="w-4 h-4" /> {roundInfo.timeRemaining}
                    </span>
                </div>
            </div>

            {/* Last Winner */}
            {lastWinner && lastWinner.round > 0 && (
                <div className="bg-space-600/50 rounded-xl p-4 mb-6 flex items-center justify-between">
                    <div className="flex items-center gap-3">
                        <Trophy className="w-6 h-6 text-forge-gold" />
                        <div>
                            <div className="text-sm text-lunar-400">Round {lastWinner.round} Winner</div>
                            <div className="text-white font-medium">{lastWinner.address}</div>
                        </div>
                    </div>
                    <div className="text-right">
                        <div className="text-green-400 font-bold">+{lastWinner.prize} XNT</div>
                    </div>
                </div>
            )}

            {/* Buy Tickets */}
            <div className="bg-space-700/50 rounded-xl p-6">
                <div className="flex items-center justify-between mb-4">
                    <span className="text-lunar-400">Tickets to buy</span>
                    <div className="flex items-center gap-2">
                        <button
                            onClick={() => setTickets(Math.max(1, tickets - 1))}
                            className="w-8 h-8 bg-space-600 rounded text-white hover:bg-space-500"
                        >-</button>
                        <span className="w-12 text-center text-white font-bold text-xl">{tickets}</span>
                        <button
                            onClick={() => setTickets(Math.min(100, tickets + 1))}
                            className="w-8 h-8 bg-space-600 rounded text-white hover:bg-space-500"
                        >+</button>
                    </div>
                </div>

                <div className="flex items-center justify-between mb-4 text-sm">
                    <span className="text-lunar-400">Cost (burned)</span>
                    <span className="text-forge-gold font-bold">{tickets * ticketPrice} XNT 🔥</span>
                </div>

                <button
                    onClick={buyTickets}
                    disabled={buying}
                    className="w-full py-3 bg-gradient-to-r from-red-500 to-orange-500 text-white rounded-xl font-bold hover:opacity-90 disabled:opacity-50 flex items-center justify-center gap-2"
                >
                    {buying ? (
                        <RefreshCw className="w-4 h-4 animate-spin" />
                    ) : (
                        <>
                            <Flame className="w-4 h-4" />
                            Burn & Buy Tickets
                        </>
                    )}
                </button>

                {roundInfo.myTickets > 0 && (
                    <div className="mt-4 text-center text-green-400 text-sm">
                        You have {roundInfo.myTickets} ticket(s) this round
                    </div>
                )}
            </div>

            {/* How it works */}
            <div className="mt-6 grid grid-cols-3 gap-4 text-center text-sm">
                <div className="p-3 bg-space-600/30 rounded-lg">
                    <div className="text-2xl mb-1">🔥</div>
                    <div className="text-lunar-400">Burn {ticketPrice} XNT</div>
                    <div className="text-white font-medium">= 1 Ticket</div>
                </div>
                <div className="p-3 bg-space-600/30 rounded-lg">
                    <div className="text-2xl mb-1">🎲</div>
                    <div className="text-lunar-400">Weekly Draw</div>
                    <div className="text-white font-medium">Sunday UTC</div>
                </div>
                <div className="p-3 bg-space-600/30 rounded-lg">
                    <div className="text-2xl mb-1">💰</div>
                    <div className="text-lunar-400">Winner Gets</div>
                    <div className="text-white font-medium">80% of Pool</div>
                </div>
            </div>
        </div>
    );
}

// ═══════════════════════════════════════════════════════════════════════════
//                              JACKPOT (MULTIPLAYER)
// ═══════════════════════════════════════════════════════════════════════════

function JackpotGame({ connected, onConnect }: { connected: boolean; onConnect: () => void }) {
    const [deposit, setDeposit] = useState(GAME_CONFIG.JACKPOT.tiers[0].toString());
    const [depositing, setDepositing] = useState(false);

    // Real Data (Default 0)
    const jackpotInfo = {
        pot: 0,
        players: 0,
        timeLeft: 'Waiting...',
        myChance: 0
    };

    const handleJoin = async () => {
        if (!connected) {
            alert("Please connect your X1 Wallet to play.");
            return onConnect();
        }

        const amount = parseInt(deposit);
        if (amount >= 500 && !window.confirm(`Confirm deposit of ${amount} XNT to Jackpot?`)) return;

        try {
            setDepositing(true);
            await new Promise(r => setTimeout(r, 1500));
            alert(`Deposited ${deposit} XNT to Jackpot!`);
        } catch (err) {
            console.error(err);
            alert("Deposit failed.");
        } finally {
            setDepositing(false);
        }
    };

    return (
        <div className="p-6 text-center">
            <h2 className="font-space text-2xl font-bold text-white mb-2">🎰 Moon Jackpot</h2>
            <p className="text-lunar-400 mb-6">Multiplayer Pot • Winner takes 95% • 5% to Reward Pool</p>

            <div className="flex gap-4 mb-6">
                <div className="flex-1 glass-card p-4 bg-forge-gold/10 border-forge-gold/30">
                    <div className="text-lunar-400 text-xs">CURRENT POT</div>
                    <div className="text-3xl font-bold text-forge-gold">{jackpotInfo.pot.toLocaleString()} XNT</div>
                </div>
                <div className="flex-1 glass-card p-4">
                    <div className="text-lunar-400 text-xs">TIME LEFT</div>
                    <div className="text-3xl font-bold text-white font-mono">{jackpotInfo.timeLeft}</div>
                </div>
            </div>

            <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg p-3 mb-6 text-xs text-left">
                <strong className="text-amber-400 flex items-center gap-1">⚠️ Multiplayer Warning</strong>
                <p className="text-lunar-300 mt-1">
                    Depositing multiple times increases your chance but you are competing against others.
                    <br />
                    <strong>Refund Rule:</strong> Bets are returned <strong>ONLY</strong> if you are the sole player when the timer ends. If any other player joins (2+ total), the game proceeds!
                </p>
            </div>

            <div className="max-w-xs mx-auto mb-6">
                <div className="flex gap-2 mb-2">
                    {GAME_CONFIG.JACKPOT.tiers.map(amt => (
                        <button
                            key={amt}
                            onClick={() => setDeposit(amt.toString())}
                            className={`flex-1 py-1 rounded text-sm ${deposit === amt.toString() ? 'bg-forge-orange text-white' : 'bg-space-600 text-lunar-400'}`}
                        >
                            {amt}
                        </button>
                    ))}
                </div>
                <button
                    onClick={handleJoin}
                    disabled={depositing}
                    className="w-full py-3 bg-gradient-to-r from-forge-orange to-forge-gold text-white rounded-xl font-bold hover:opacity-90 disabled:opacity-50"
                >
                    {depositing ? 'Processing...' : `Join Round (${deposit} XNT)`}
                </button>
                <div className="text-xs text-lunar-500 mt-2">
                    Your win chance with this bet: ~{((parseInt(deposit) / (jackpotInfo.pot + parseInt(deposit))) * 100).toFixed(1)}%
                </div>
            </div>

            {/* Players List */}
            <div className="text-left bg-space-700/30 rounded-xl p-4">
                <div className="text-xs text-lunar-400 mb-2 uppercase font-bold">Recent Deposits</div>
                <div className="space-y-2 text-sm text-lunar-500 text-center py-4">
                    Waiting for players...
                </div>
            </div>
        </div>
    );
}

// ═══════════════════════════════════════════════════════════════════════════
//                              ARTIFACT DUEL
// ═══════════════════════════════════════════════════════════════════════════

function DuelGame({ connected, onConnect }: { connected: boolean; onConnect: () => void }) {
    const [selectedTier, setSelectedTier] = useState<string | null>(null);
    const [status, setStatus] = useState<'idle' | 'searching' | 'fighting' | 'result'>('idle');
    const entryFee = GAME_CONFIG.DUEL.entryFee;
    const prize = GAME_CONFIG.DUEL.prizePool;

    const handleDuel = async () => {
        if (!connected) {
            alert("Please connect your X1 Wallet to play.");
            return onConnect();
        }
        if (!selectedTier) return alert('Select your fighter first!');

        try {
            setStatus('searching');
            await new Promise(r => setTimeout(r, 1500));
            setStatus('fighting');
            await new Promise(r => setTimeout(r, 2000));
            setStatus('result');
        } catch (err) {
            console.error(err);
            setStatus('idle');
            alert("Duel cancelled or failed.");
        }
    };

    const tiers = [
        { id: 'void_anomaly', name: 'Void Anomaly', icon: '🌑', beats: 'Solar Core', color: 'text-pink-400' },
        { id: 'solar_core', name: 'Solar Core', icon: '🔥', beats: 'Cosmic Shard', color: 'text-forge-gold' },
        { id: 'cosmic_shard', name: 'Cosmic Shard', icon: '🔮', beats: 'Lunar Dust', color: 'text-mission-orbit' },
        { id: 'lunar_dust', name: 'Lunar Dust', icon: '❄️', beats: 'Void Anomaly', color: 'text-lunar-300' },
    ];

    if (status === 'result') {
        return (
            <div className="p-12 text-center">
                <div className="text-6xl mb-4">👑</div>
                <h3 className="text-3xl font-bold text-white mb-2">VICTORY!</h3>
                <p className="text-forge-gold text-xl mb-6">+{prize.toFixed(2)} XNT</p>
                <div className="p-4 bg-space-700/50 rounded-lg mb-6 max-w-sm mx-auto">
                    <div className="flex items-center justify-between text-sm">
                        <span>Your 🌑 Void Anomaly</span>
                        <span className="text-green-400">WIN</span>
                    </div>
                    <div className="flex items-center justify-between text-sm mt-2 opacity-50">
                        <span>Opponent's 🔥 Solar Core</span>
                        <span className="text-red-400">LOSE</span>
                    </div>
                </div>
                <button
                    onClick={() => setStatus('idle')}
                    className="px-6 py-2 bg-space-600 rounded-lg text-white hover:bg-space-500"
                >
                    Play Again
                </button>
            </div>
        );
    }

    return (
        <div className="p-6 text-center">
            <h2 className="font-space text-2xl font-bold text-white mb-2">⚔️ Artifact Duel</h2>
            <p className="text-lunar-400 mb-6">Rock-Paper-Scissors with NFTs • Best of 1</p>

            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-8">
                {tiers.map(tier => (
                    <button
                        key={tier.id}
                        onClick={() => setSelectedTier(tier.id)}
                        className={`p-4 rounded-xl border transition-all ${selectedTier === tier.id ? 'bg-space-600 border-forge-orange shadow-[0_0_15px_rgba(249,115,22,0.3)]' : 'bg-space-700/30 border-transparent hover:border-white/20'}`}
                    >
                        <div className="text-3xl mb-2">{tier.icon}</div>
                        <div className={`font-bold text-sm ${tier.color}`}>{tier.name}</div>
                        <div className="text-[10px] text-lunar-500 mt-1">Beats {tier.beats}</div>
                    </button>
                ))}
            </div>

            <div className="max-w-xs mx-auto">
                <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg p-3 mb-4 text-xs text-left">
                    <p className="text-lunar-300">
                        <strong>Note:</strong> Refund is issued if no opponent is found. If you join twice, you play against yourself!
                    </p>
                </div>
                <div className="flex justify-between text-sm mb-2 text-lunar-400">
                    <span>Entry Fee</span>
                    <span className="text-white">{entryFee.toFixed(2)} XNT</span>
                </div>
                <div className="flex justify-between text-sm mb-6 text-lunar-400">
                    <span>Prize (Winner takes)</span>
                    <span className="text-forge-gold">{prize.toFixed(2)} XNT</span>
                </div>

                <button
                    onClick={handleDuel}
                    disabled={status !== 'idle'}
                    className="w-full py-4 bg-gradient-to-r from-red-600 to-orange-600 text-white rounded-xl font-bold hover:brightness-110 disabled:opacity-50 text-lg flex items-center justify-center gap-2"
                >
                    {status === 'searching' ? (
                        <>
                            <RefreshCw className="w-5 h-5 animate-spin" /> Looking for opponent...
                        </>
                    ) : status === 'fighting' ? (
                        <>
                            <Swords className="w-5 h-5 animate-pulse" /> FIGHTING...
                        </>
                    ) : (
                        <>
                            <Swords className="w-5 h-5" /> START DUEL
                        </>
                    )}
                </button>
            </div>
        </div>
    );
}

// ═══════════════════════════════════════════════════════════════════════════
//                              PREDICTIONS
// ═══════════════════════════════════════════════════════════════════════════

function PredictionsGame({ connected, onConnect }: { connected: boolean; onConnect: () => void }) {
    // Real Data (Markets open for betting, starting at 0 pool)
    const markets = [
        { id: 1, q: "Will ETH reach $5,000 by Feb 1st?", end: "Feb 1, 2026", yes: 50, pool: 0, status: 'OPEN' },
        { id: 2, q: "XNT Total Burn > 500k this Epoch?", end: "Epoch End (Sunday)", yes: 50, pool: 0, status: 'OPEN' }
    ];

    const createMarket = async () => {
        if (!connected) {
            alert("Please connect your X1 Wallet to play.");
            return onConnect();
        }

        try {
            // Mock async creation
            await new Promise(r => setTimeout(r, 1000));
            alert(`Market Creation Wizard\n\nRequired Bond: ${GAME_CONFIG.PREDICTIONS.marketBond} XNT\nFee: ${GAME_FEES.PREDICTIONS * 100}%\n\n(Modal would open here - Logic waiting for Smart Contract)`);
        } catch (err) {
            console.error(err);
            alert("Failed to create market.");
        }
    };

    return (
        <div className="p-6">
            <div className="flex items-center justify-between mb-6">
                <div>
                    <h2 className="font-space text-2xl font-bold text-white flex items-center gap-2">
                        <BarChart3 className="w-6 h-6 text-mission-launchpad" /> Predictions
                    </h2>
                    <p className="text-lunar-400 text-sm">Bet on future outcomes • Yes/No Markets</p>
                </div>
                <button
                    onClick={createMarket}
                    className="px-4 py-2 bg-space-800 border border-mission-launchpad/50 rounded-lg text-mission-launchpad hover:bg-space-700 text-sm font-bold flex items-center gap-2"
                >
                    + Create Market
                </button>
            </div>

            <div className="space-y-4">
                {markets.map(m => (
                    <div key={m.id} className="glass-card p-4 hover:border-white/20 transition-colors">
                        <div className="flex justify-between items-start mb-3">
                            <h3 className="font-medium text-white pr-4">{m.q}</h3>
                            <div className="flex flex-col items-end gap-1">
                                <span className="flex items-center gap-1 text-xs text-forge-orange bg-forge-orange/10 px-2 py-1 rounded">
                                    <Clock className="w-3 h-3" /> Ends: {m.end}
                                </span>
                                <span className="text-[10px] text-green-400 font-bold uppercase tracking-wider">{m.status}</span>
                            </div>
                        </div>

                        {/* Progress Bar (Locked at 50/50 for 0 pool) */}
                        <div className="h-2 bg-space-600 rounded-full overflow-hidden flex mb-2">
                            <div className="bg-lunar-500/50" style={{ width: `50%` }}></div>
                            <div className="bg-lunar-500/50" style={{ width: `50%` }}></div>
                        </div>

                        <div className="flex justify-between items-center">
                            <div className="text-xs text-lunar-400">
                                Pool: <span className="text-white font-mono">{m.pool.toLocaleString()} XNT</span>
                                <span className="ml-2 opacity-50">(No bets yet)</span>
                            </div>
                            <div className="flex gap-2">
                                <button className="px-3 py-1 bg-green-500/10 text-green-400 text-sm rounded border border-green-500/30 hover:bg-green-500/20 cursor-not-allowed" title="Markets open after deployment">
                                    Yes
                                </button>
                                <button className="px-3 py-1 bg-red-500/10 text-red-400 text-sm rounded border border-red-500/30 hover:bg-red-500/20 cursor-not-allowed" title="Markets open after deployment">
                                    No
                                </button>
                            </div>
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
}
