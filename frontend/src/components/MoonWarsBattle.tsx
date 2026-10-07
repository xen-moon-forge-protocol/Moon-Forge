/**
 * Moon Wars — FREE PRACTICE against a local training bot. No wallet, no XNT, nothing on-chain.
 */
import { useEffect, useState } from 'react';
import { Swords, Trophy, Gamepad2 } from 'lucide-react';
import { MoonWarsEngine, GameState, PRACTICE_DECK, Card } from '../lib/games/MoonWarsEngine';

const ME = 'You';
const BOT = 'TrainingBot';
const TIER_STYLE = [
    'border-lunar-300 text-lunar-200',
    'border-mission-orbit text-mission-orbit',
    'border-forge-gold text-forge-gold',
    'border-pink-500 text-pink-400',
];

export default function MoonWarsBattle() {
    const [engine, setEngine] = useState<MoonWarsEngine | null>(null);
    const [state, setState] = useState<GameState | null>(null);
    const [selected, setSelected] = useState<number | null>(null);
    const [msg, setMsg] = useState<string | null>(null);

    const sync = (e: MoonWarsEngine) => setState({ ...e.state, player1: { ...e.state.player1 }, player2: { ...e.state.player2 } });

    const start = () => {
        const e = new MoonWarsEngine('practice', ME, BOT);
        e.setDeck(ME, PRACTICE_DECK);
        e.setDeck(BOT, PRACTICE_DECK);
        setEngine(e);
        setSelected(null);
        setMsg(null);
        sync(e);
    };

    const act = (fn: () => void) => {
        if (!engine) return;
        try {
            fn();
            setMsg(null);
        } catch (err: any) {
            setMsg(err.message);
        }
        sync(engine);
    };

    // the bot plays automatically on its turn
    useEffect(() => {
        if (!engine || !state || state.status !== 'PLAYING' || state.turnPlayer !== BOT) return;
        const id = setTimeout(() => {
            try { engine.botTurn(BOT); } catch { engine.endTurn(); }
            sync(engine);
        }, 700);
        return () => clearTimeout(id);
    }, [engine, state]);

    if (!state || !engine) {
        return (
            <div className="min-h-[360px] flex flex-col items-center justify-center bg-space-900/50 rounded-xl border border-white/5 p-8 text-center">
                <div className="w-16 h-16 rounded-full bg-forge-gold/10 flex items-center justify-center mb-4">
                    <Swords className="w-8 h-8 text-forge-gold" />
                </div>
                <h3 className="text-xl font-bold text-white mb-2">Moon Wars — free practice</h3>
                <p className="text-lunar-400 mb-6 max-w-md text-sm">
                    A card duel against a local training bot, using the four Artifact elements as units. No wallet, no XNT, nothing is sent on-chain.
                </p>
                <button onClick={start} className="btn-forge flex items-center gap-2"><Gamepad2 className="w-5 h-5" /> Start practice</button>
            </div>
        );
    }

    const me = state.player1, bot = state.player2;
    const myTurn = state.status === 'PLAYING' && state.turnPlayer === ME;

    return (
        <div className="rounded-xl border border-white/5 bg-space-900/70 p-4 space-y-4">
            <div className="text-center text-xs text-amber-300">Free practice — no XNT</div>

            {/* Bot side */}
            <div className="flex items-center justify-between">
                <div className="text-red-400 font-mono">BOT · HP {bot.health} · Mana {bot.mana} · Hand {bot.hand.length} · Deck {bot.deck.length}</div>
                <div className="text-xs text-lunar-400">{state.turnPlayer === BOT && state.status === 'PLAYING' ? 'Bot is playing…' : ''}</div>
            </div>
            <div className="flex flex-wrap gap-2 min-h-[110px] p-2 rounded-lg bg-red-500/5 border border-red-500/10">
                {bot.field.map((c, i) => (
                    <button key={c.uid} disabled={!myTurn || selected === null} onClick={() => act(() => { engine.attack(ME, selected!, i); setSelected(null); })}>
                        <CardView c={c} highlight={myTurn && selected !== null} />
                    </button>
                ))}
                {bot.field.length === 0 && <div className="text-lunar-500 text-sm italic m-auto">No enemy units</div>}
            </div>

            {/* Controls */}
            <div className="flex flex-wrap items-center justify-center gap-2">
                <button
                    disabled={!myTurn || selected === null || bot.field.length > 0}
                    onClick={() => act(() => { engine.attack(ME, selected!, 'face'); setSelected(null); })}
                    className="btn-outline !px-4 !py-2 text-sm disabled:opacity-40"
                >
                    Attack bot directly
                </button>
                <button disabled={!myTurn} onClick={() => act(() => { setSelected(null); engine.endTurn(ME); })} className="btn-forge !px-4 !py-2 text-sm">End turn</button>
                <button onClick={start} className="text-xs text-lunar-400 hover:text-white">Restart</button>
            </div>
            {msg && <div className="text-center text-xs text-amber-300">{msg}</div>}

            {/* My field */}
            <div className="flex flex-wrap gap-2 min-h-[110px] p-2 rounded-lg bg-green-500/5 border border-green-500/10">
                {me.field.map((c, i) => (
                    <button key={c.uid} disabled={!myTurn || !c.canAttack} onClick={() => setSelected(selected === i ? null : i)} title={c.canAttack ? 'Select to attack' : 'Cannot attack this turn'}>
                        <CardView c={c} selected={selected === i} dim={!c.canAttack} />
                    </button>
                ))}
                {me.field.length === 0 && <div className="text-lunar-500 text-sm italic m-auto">No units deployed</div>}
            </div>

            {/* My hand */}
            <div className="flex items-center justify-between">
                <div className="text-green-400 font-mono">YOU · HP {me.health} · Mana {me.mana} · Deck {me.deck.length}</div>
            </div>
            <div className="flex flex-wrap gap-2">
                {me.hand.map((c, i) => (
                    <button key={c.uid} disabled={!myTurn || c.cost > me.mana} onClick={() => act(() => engine.playCard(ME, i))} title={`Play for ${c.cost} mana`}>
                        <CardView c={c} dim={c.cost > me.mana} showCost />
                    </button>
                ))}
            </div>

            <div className="max-h-28 overflow-y-auto text-[11px] font-mono text-lunar-500 bg-black/20 rounded p-2">
                {state.actionLog.slice(-8).map((l, i) => <div key={i}>{l}</div>)}
            </div>

            {state.status === 'FINISHED' && (
                <div className="text-center p-4 rounded-xl bg-black/40">
                    <Trophy className="w-10 h-10 text-forge-gold mx-auto mb-2" />
                    <div className="text-2xl font-bold text-white mb-2">{state.winner === ME ? 'You win (practice)' : state.winner === BOT ? 'The bot wins' : 'Draw'}</div>
                    <button onClick={start} className="btn-forge">Play again</button>
                </div>
            )}
        </div>
    );
}

function CardView({ c, selected, dim, highlight, showCost }: { c: Card; selected?: boolean; dim?: boolean; highlight?: boolean; showCost?: boolean }) {
    return (
        <div className={`w-24 h-28 rounded-lg border-2 bg-space-800 p-1.5 flex flex-col text-left transition-all ${TIER_STYLE[c.element]} ${selected ? 'ring-2 ring-forge-orange -translate-y-1' : ''} ${dim ? 'opacity-50' : ''} ${highlight ? 'hover:ring-2 hover:ring-red-400' : ''}`}>
            <div className="flex justify-between text-[10px]">
                <span className="truncate">{c.name}</span>
                {showCost && <span className="text-cyan-300 font-bold">{c.cost}</span>}
            </div>
            <div className="flex-1" />
            <div className="flex justify-between text-sm font-bold font-mono">
                <span className="text-orange-400">⚔{c.power}</span>
                <span className="text-green-400">🛡{c.defense}</span>
            </div>
        </div>
    );
}
