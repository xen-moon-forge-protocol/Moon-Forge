/**
 * Moon Forge Bot: what the forkable user bot (bots/moon-forge-bot) is for, who it is for, how it works, how to get and
 * adapt it, safety and risks. Every text comes from src/facts.ts (`bot`), the same source as the static /bot/ page,
 * llms.txt and llms-full.txt. No wallet, no live data: the bot runs on the user's own computer, never on this site.
 */
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Bot, ExternalLink } from 'lucide-react';
import { ageNotice, bot, scale } from '../facts';

function Section({ title, children }: { title: string; children: ReactNode }) {
    return (
        <section className="glass-card">
            <h2 className="font-space text-xl text-white mb-3">{title}</h2>
            <div className="text-sm text-lunar-300 space-y-3 leading-relaxed">{children}</div>
        </section>
    );
}

const ext = (href: string, label: string) => (
    <a href={href} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-forge-orange hover:underline">
        {label} <ExternalLink className="w-3 h-3" />
    </a>
);

export default function BotPage() {
    return (
        <div className="max-w-4xl mx-auto space-y-6">
            <div className="text-center mb-4">
                <h1 className="font-space text-4xl font-bold mb-2"><Bot className="inline w-8 h-8 text-forge-gold mr-2" />{bot.name}</h1>
                <p className="text-lunar-400">{bot.summary}</p>
                <p className="text-sm mt-2">{ext(bot.source, 'Get it: bots/moon-forge-bot on GitHub')}</p>
            </div>

            <section className="glass-card border border-forge-orange/30">
                <p className="text-sm text-white font-semibold">{scale}</p>
                <p className="text-sm text-lunar-300 mt-2">{bot.today}</p>
            </section>

            <Section title="What it does">
                <ul className="space-y-2">
                    {bot.jobs.map((j) => <li key={j.title}><strong className="text-white">{j.title}.</strong> {j.text}</li>)}
                </ul>
                <p className="text-xs text-lunar-500">{ageNotice}</p>
            </Section>

            <Section title="Who it is for">
                <ul className="list-disc list-inside space-y-1">{bot.forWhom.map((w) => <li key={w}>{w}</li>)}</ul>
            </Section>

            <Section title="How to get it and run it, step by step">
                <ol className="list-decimal list-inside space-y-1">{bot.steps.map((s) => <li key={s}>{s}</li>)}</ol>
                <p>Full guide, config examples and the list of every setting: {ext(bot.readme, 'README')} · agent card: {ext(bot.card, 'agent-card.json')}.</p>
            </Section>

            <Section title="Copy it, fork it, adapt it">
                <p>{bot.adapt}</p>
            </Section>

            <Section title="Safety">
                <ul className="list-disc list-inside space-y-1">{bot.safety.map((s) => <li key={s}>{s}</li>)}</ul>
            </Section>

            <Section title="Risks, plainly">
                <ul className="list-disc list-inside space-y-1">{bot.risks.map((r) => <li key={r}>{r}</li>)}</ul>
                <p className="text-xs text-lunar-500">{bot.community}</p>
            </Section>

            <p className="text-center text-xs text-lunar-500">
                New here? <Link className="text-forge-orange hover:underline" to="/start">Start here</Link> · burning by hand: <Link className="text-forge-orange hover:underline" to="/forge">The Forge</Link> · claims by hand: <Link className="text-forge-orange hover:underline" to="/missions">Missions</Link>.
            </p>
        </div>
    );
}
