import { useState } from 'react';
import { Users, Trophy, RefreshCw, Gamepad2, Swords } from 'lucide-react';
import { useWallet } from '../context/WalletContext';
import { MoonWarsEngine, GameState } from '../lib/games/MoonWarsEngine';

export default function MoonWarsBattle() {
    const { x1Connected, connectX1, x1Address } = useWallet();
    const [engine, setEngine] = useState<MoonWarsEngine | null>(null);
    const [gameState, setGameState] = useState<GameState | null>(null);
    const [loading, setLoading] = useState(false);

    // Initial State: Lobby
    if (!x1Connected) {
        return (
            <div className="min-h-[400px] flex flex-col items-center justify-center bg-space-900/50 rounded-xl border border-white/5 p-8 text-center">
                <div className="w-16 h-16 bg-space-800 rounded-full flex items-center justify-center mb-4">
                    <Gamepad2 className="w-8 h-8 text-white" />
                </div>
                <h3 className="text-xl font-bold text-white mb-2">Moon Wars Training</h3>
                <p className="text-lunar-400 mb-6 max-w-sm">Connect your wallet to load your Artifacts and enter the simulation deck.</p>
                <button onClick={connectX1} className="px-6 py-2 bg-forge-orange text-white rounded-lg hover:bg-forge-orange/80 transition-colors">Connect X1 Wallet</button>
            </div>
        );
    }

    const startTraining = () => {
        setLoading(true);
        // Simulate loading deck from wallet
        setTimeout(() => {
            const newEngine = new MoonWarsEngine("training_01", x1Address || "Player", "TrainingBot");
            // Mock deck for now (Logic handles real IDs later)
            newEngine.setDeck(x1Address || "Player", [1, 2, 601, 905, 995]);
            newEngine.setDeck("TrainingBot", [5, 12, 650, 920, 10]);

            setEngine(newEngine);
            setGameState({ ...newEngine.state }); // Force update
            setLoading(false);
        }, 1000);
    };

    const handleAction = (action: () => void) => {
        try {
            action();
            if (engine) setGameState({ ...engine.state });
        } catch (err: any) {
            alert(err.message);
        }
    };

    if (!gameState) {
        return (
            <div className="min-h-[400px] flex flex-col items-center justify-center bg-space-900/50 rounded-xl border border-white/5 p-8 text-center">
                <div className="w-20 h-20 rounded-full bg-forge-gold/10 flex items-center justify-center mb-4 animate-pulse">
                    <Swords className="w-10 h-10 text-forge-gold" />
                </div>
                <h3 className="text-xl font-bold text-white mb-2">Ready for Battle?</h3>
                <p className="text-lunar-400 mb-6 max-w-sm">
                    Enter <strong>Training Mode</strong> to test your deck mechanics against the AI engine.
                    <br /><span className="text-xs text-space-400">(Uses local engine logic, no gas fees)</span>
                </p>
                <button
                    onClick={startTraining}
                    disabled={loading}
                    className="px-8 py-3 bg-gradient-to-r from-forge-orange to-forge-gold text-white rounded-lg font-bold hover:shadow-glow transition-all flex items-center gap-2"
                >
                    {loading ? <RefreshCw className="w-5 h-5 animate-spin" /> : <Gamepad2 className="w-5 h-5" />}
                    Enter Training Arena
                </button>
            </div>
        );
    }

    return (
        <div className="rounded-xl overflow-hidden min-h-[600px] relative border border-white/5 bg-[url('https://images.unsplash.com/photo-1475274047050-1d0c0975c63e?auto=format&fit=crop&w=2000&q=80')] bg-cover bg-center">
            <div className="absolute inset-0 bg-space-950/90 backdrop-blur-sm"></div>

            {/* Enemy Field */}
            <div className="absolute top-0 w-full h-1/3 p-4 flex justify-between items-start z-10 border-b border-white/5 bg-black/20">
                <div className="flex flex-col items-center">
                    <div className="w-12 h-12 rounded-full bg-red-900/50 flex items-center justify-center border border-red-500 mb-2">
                        <Users className="w-6 h-6 text-red-500" />
                    </div>
                    <div className="text-red-400 text-xs font-mono">BOT</div>
                </div>
                <div className="flex flex-col items-center">
                    <div className="text-red-500 font-mono text-2xl font-bold drop-shadow-glow">HP: {gameState.player2.health}</div>
                    <div className="flex gap-1 mt-2">
                        {gameState.player2.field.map((c, i) => (
                            <CardUnit key={i} {...c} size="small" tier={c.element === 0 ? 'lunar' : 'solar'} />
                        ))}
                    </div>
                </div>
                <div className="flex flex-col items-end">
                    <div className="text-xs text-space-400 mb-1">Mana: {gameState.player2.mana}</div>
                    <div className="flex gap-1">
                        {[...Array(gameState.player2.hand.length)].map((_, i) => (
                            <div key={i} className="w-8 h-10 bg-space-800 rounded border border-white/10"></div>
                        ))}
                    </div>
                </div>
            </div>

            {/* Action Log */}
            <div className="absolute top-1/2 left-4 -translate-y-1/2 w-64 h-32 overflow-hidden pointer-events-none opacity-50 z-0">
                {gameState.actionLog.slice(-5).map((log, i) => (
                    <div key={i} className="text-[10px] text-lunar-500 mb-1 font-mono">{log}</div>
                ))}
            </div>

            {/* My Field */}
            <div className="absolute bottom-0 w-full h-1/2 p-4 flex flex-col justify-end z-10 bg-gradient-to-t from-black via-space-950 to-transparent">
                {/* Units */}
                <div className="flex justify-center gap-4 mb-4 min-h-[120px]">
                    {gameState.player1.field.map((c, i) => (
                        <div key={i} onClick={() => handleAction(() => engine?.attack(x1Address || "Player", i, 'face'))} className="cursor-pointer hover:scale-105 transition-transform" title="Click to Attack Face">
                            <CardUnit {...c} size="medium" tier={c.element === 0 ? 'lunar' : c.element === 2 ? 'solar' : 'cosmic'} />
                        </div>
                    ))}
                    {gameState.player1.field.length === 0 && <div className="text-space-600 text-sm italic py-8">No units deployed</div>}
                </div>

                {/* Hand */}
                <div className="flex items-end justify-center gap-2 pb-2">
                    {gameState.player1.hand.map((c, i) => (
                        <div key={i} onClick={() => handleAction(() => engine?.playCard(x1Address || "Player", i))} className="cursor-pointer hover:-translate-y-6 transition-transform">
                            <CardUnit {...c} size="large" tier={c.element === 0 ? 'lunar' : c.element === 2 ? 'solar' : c.element === 1 ? 'cosmic' : 'void'} />
                        </div>
                    ))}
                </div>

                {/* HUD */}
                <div className="absolute bottom-4 left-4">
                    <div className="text-forge-cyan font-bold text-xl drop-shadow-glow mb-1">Mana: {gameState.player1.mana}/10</div>
                    <button onClick={() => handleAction(() => engine?.endTurn())} className="px-3 py-1 bg-space-700 text-xs rounded hover:bg-space-600 border border-white/10 uppercase tracking-widest">End Turn</button>
                </div>
                <div className="absolute bottom-4 right-4">
                    <div className="text-green-400 font-bold text-3xl drop-shadow-glow">HP: {gameState.player1.health}</div>
                </div>
            </div>

            {gameState.winner && (
                <div className="absolute inset-0 z-50 bg-black/80 flex items-center justify-center">
                    <div className="text-center animate-bounce">
                        <Trophy className="w-16 h-16 text-forge-gold mx-auto mb-4" />
                        <h2 className="text-4xl font-bold text-white mb-2">{gameState.winner === 'TrainingBot' ? 'DEFEAT' : 'VICTORY!'}</h2>
                        <button onClick={() => setGameState(null)} className="btn-forge mt-4">Play Again</button>
                    </div>
                </div>
            )}
        </div>
    );
}

// Reusable Card Component
function CardUnit({ name, cost, power, defense, tier, size = 'large' }: any) {
    const colors = {
        lunar: 'border-lunar-400 bg-space-900 text-lunar-300',
        cosmic: 'border-mission-orbit bg-space-900 text-mission-orbit',
        solar: 'border-forge-gold bg-space-900 text-forge-gold',
        void: 'border-pink-500 bg-space-900 text-pink-400',
    };

    // Size variants
    if (size === 'small') {
        return (
            <div className={`w-8 h-10 rounded border ${colors[tier as keyof typeof colors]} flex items-center justify-center text-xs font-bold`}>
                {power}
            </div>
        );
    }

    if (size === 'medium') {
        return (
            <div className={`w-20 h-28 rounded-lg border-2 flex flex-col items-center p-1 ${colors[tier as keyof typeof colors]}`}>
                <div className="text-xs font-bold w-full text-right">{cost}</div>
                <div className="text-2xl my-auto">🛡️</div>
                <div className="flex justify-between w-full px-1 text-xs font-bold">
                    <span>{power}</span><span>{defense}</span>
                </div>
            </div>
        );
    }

    return (
        <div className={`w-28 h-40 rounded-xl border-2 relative group overflow-hidden bg-contain ${colors[tier as keyof typeof colors]}`}>
            <div className="absolute top-1 left-1 bg-black/60 w-6 h-6 rounded flex items-center justify-center text-sm font-bold text-cyan-400 border border-cyan-400/30">
                {cost}
            </div>
            <div className="p-2 text-center bg-black/60 h-full flex flex-col justify-end">
                <div className="font-bold text-xs mb-1 truncate">{name}</div>
                <div className="flex justify-between px-2 font-mono text-sm font-bold">
                    <span className="text-orange-400 flex items-center gap-0.5">⚔️{power}</span>
                    <span className="text-green-400 flex items-center gap-0.5">🛡️{defense}</span>
                </div>
            </div>
        </div>
    );
}
