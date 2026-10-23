#!/usr/bin/env node
/**
 * Moon Forge — prerender + discoverability generator (runs after `vite build`).
 *
 *   node scripts/prerender.mjs                 writes dist/<route>/index.html for every route in src/facts.ts (static HTML
 *                                              inside #root for readers without JavaScript; React's createRoot replaces it),
 *                                              dist/404.html, dist/llms.txt, dist/llms-full.txt, dist/sitemap.xml
 *   node scripts/prerender.mjs --write-public  regenerates public/llms.txt, public/llms-full.txt, public/sitemap.xml from facts
 *   node scripts/prerender.mjs --check         regenerates them in memory and fails if the public/ copies differ (drift check)
 *
 * Everything is derived from src/facts.ts (bundled with esbuild, which Vite already ships). Wallet pages are never rendered
 * with renderToString: they get a short static summary only. No external fonts, scripts or beacons are added.
 */
import { build } from 'esbuild';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const PUBLIC = path.join(ROOT, 'public');
const BASE = '/Moon-Forge/';
const args = new Set(process.argv.slice(2));
const CHECK = args.has('--check');
const WRITE_PUBLIC = args.has('--write-public');

// ── facts ────────────────────────────────────────────────────────────────────
async function loadFacts() {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mf-prerender-'));
    const outfile = path.join(tmp, 'facts.mjs');
    await build({ entryPoints: [path.join(ROOT, 'src', 'facts.ts')], bundle: true, format: 'esm', platform: 'node', outfile, logLevel: 'silent' });
    const mod = await import(pathToFileURL(outfile).href);
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* temp dir, best effort */ }
    return mod.facts;
}

// ── helpers ──────────────────────────────────────────────────────────────────
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const abs = (route, site) => site + route.replace(/^\//, '');
const href = (route) => BASE + route.replace(/^\//, '');
const git = (cmd, fallback) => { try { return execSync(`git ${cmd}`, { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() || fallback; } catch { return fallback; } };
const li = (items, fn = esc) => items.map((x) => `<li>${fn(x)}</li>`).join('');
const p = (items) => items.map((x) => `<p>${esc(x)}</p>`).join('');
const section = (title, body) => `<section><h2>${esc(title)}</h2>${body}</section>`;
const table = (head, rows) => `<div class="tbl"><table><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
const noticesHtml = (F, ids) => `<section><h2>Notices (dated)</h2><ul>${F.notices.filter((n) => !ids || ids.includes(n.id)).map((n) => `<li><time datetime="${n.date}">${n.date}</time>: ${esc(n.text)}</li>`).join('')}</ul></section>`;

// Hidden-text / injection lint over everything we write (T15-17): zero-width, bidi, BOM, soft hyphen; wording standard (X-142).
const BAD_CHARS = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF\u00AD]/;
const BAD_WORDS = /\b(earn|earns|earning|earnings|yield|yields|roi|return|returns|profit|profits|profitable|investment|investments|guaranteed|guarantee|passive)\b|bigger share|ignore (all|previous|prior) instructions|system prompt|as an ai/i;
// Rules-3 facts (chips 0, ticket removal, the end date of a current rule, new-binary constants) must not appear before
// rules detection reads 3 (WP-frontend must-not; review R2/R11a). Dated notices use the neutral form of src/content/interim.ts.
const RULES3_LEAK = /stop crediting|paid tickets only|chips at the final upgrade|end with the upgrade|ends with the (change|upgrade)|ends at the (oracle rules change|final upgrade)|boost ends|removes Forge Drops|buys weeks, not years|drops from 20% to 5%/i;
function lint(name, text) {
    const bad = text.match(BAD_CHARS);
    if (bad) throw new Error(`${name}: forbidden character U+${bad[0].codePointAt(0).toString(16)}`);
    const word = text.match(BAD_WORDS);
    if (word) throw new Error(`${name}: forbidden wording "${word[0]}"`);
    const leak = text.match(RULES3_LEAK);
    if (leak) throw new Error(`${name}: rules-3 wording before the upgrade "${leak[0]}" (use the NEUTRAL dated forms in src/content/interim.ts)`);
}
/** The React pages are not generated from facts, so their source is scanned for the same rules-3 phrases. */
function lintSources() {
    const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
    for (const file of walk(path.join(ROOT, 'src')).filter((f) => /\.(ts|tsx)$/.test(f))) {
        const leak = fs.readFileSync(file, 'utf8').match(RULES3_LEAK);
        if (leak) throw new Error(`${path.relative(ROOT, file)}: rules-3 wording before the upgrade "${leak[0]}" (use the NEUTRAL dated forms in src/content/interim.ts)`);
    }
}

// ── static page bodies (plain HTML from facts; styled by a small inline stylesheet) ──
const STYLE = `<style id="prerender-style">.prerender{max-width:56rem;margin:0 auto;padding:1.5rem 1rem;line-height:1.6;color:#d6d8e6;font-family:ui-sans-serif,system-ui,sans-serif}.prerender h1{font-size:1.9rem;margin:0 0 .5rem}.prerender h2{font-size:1.2rem;margin:1.6rem 0 .5rem;color:#fff}.prerender h3{font-size:1rem;margin:1rem 0 .3rem;color:#fff}.prerender a{color:#ff8a1f}.prerender code{font-size:.85em;word-break:break-all}.prerender nav a{margin-right:.9rem}.prerender .tbl{overflow-x:auto}.prerender table{border-collapse:collapse;font-size:.9rem}.prerender th,.prerender td{text-align:left;padding:.25rem .6rem;border-bottom:1px solid rgba(255,255,255,.1)}.prerender details{border-bottom:1px solid rgba(255,255,255,.08);padding:.4rem 0}.prerender summary{cursor:pointer;color:#fff}.prerender .muted{color:#8b8fa8;font-size:.85rem}</style>`;

function nav(F) {
    const items = F.routes.filter((r) => r.index).map((r) => `<a href="${href(r.path)}">${esc(r.title.replace(/ \|.*$/, '').replace(/^Moon Forge$/, 'Home'))}</a>`);
    return `<nav aria-label="Pages">${items.join('')}</nav>`;
}

function verifyBlock(F) {
    const I = F.identity;
    return section('Verify you are on the real site', `<ul>
<li>Site: <code>${esc(F.officialLinks.site)}</code></li>
<li>X1 program: <code>${esc(I.programId)}</code> (source tag <code>${esc(F.rules.program)}</code>)</li>
<li>Burn portal, the same address on every supported chain: <code>${esc(I.portal)}</code></li>
<li>Artifacts collection (Metaplex Core): <code>${esc(I.collectionPda)}</code></li>
<li>Source: <a href="${esc(F.officialLinks.github)}">${esc(F.officialLinks.github)}</a> · X: <a href="${esc(F.officialLinks.x)}">@MoonXenForge</a></li>
</ul><p class="muted">Any other program ID, portal, collection, site or "claim" page is not Moon Forge.</p>`);
}

const faqHtml = (F) => F.faq.map((f) => `<details><summary>${esc(f.q)}</summary><p>${esc(f.a)}</p></details>`).join('');
const rulesLine = (F) => `<p class="muted">Rules described: program tag ${esc(F.rules.program)}, oracle ${esc(F.rules.oracle)}, valid from ${esc(F.rules.validFrom)}; texts checked on ${esc(F.rules.describedAsOf)}.</p>`;

function bodyHome(F) {
    return `<h1>Moon Forge</h1><p><strong>${esc(F.identity.tagline)}</strong></p><p>${esc(F.identity.description)}</p>
${section('How it works', `<ol>${li(['Burn XEN on a supported chain through the Moon Forge portal (approval for the exact amount, then the burn; XEN’s own burn runs).', 'Every Sunday 00:00 UTC the oracle values the week’s burns at each chain’s market price and publishes the epoch on X1 with its full data file.', 'Claim: permissionless; the public keeper usually submits it for you.', 'Receive XNT on X1: Launchpad at claim, Orbit over 45 days, Moon Landing over 180 days.'])}</ol>`)}
${section('Live chains', `<p>Portals are live on ${esc(F.liveChains.map((c) => c.name).join(', '))}. Ethereum and PulseChain have no portal and none is planned by this project.</p>`)}
${section('Not to be confused with', `<ul>${li(F.disambiguation)}</ul><p>${esc(F.oldBurns)}</p>`)}
${verifyBlock(F)}
${noticesHtml(F)}
${rulesLine(F)}`;
}

function bodyStart(F) {
    return `<h1>Start here</h1><p>Moon Forge burns XEN that is hard to sell and pays XNT on X1. Every rule is public and every payout can be recomputed; trust is limited to a bounded oracle and, until it is burned, the upgrade key. This page shows how to use it and how to check it yourself; the live numbers (this week’s budget, fair capacity, XNT price) need JavaScript.</p>
<p class="muted">Independent, open-source, run by one anonymous builder who receives only the disclosed cuts. Not run by the XEN or X1 teams, not XEN Prime, not X1 Forge.</p>
${section('How much can it pay', `<p>An epoch pays at most ${F.epochRules.budgetPctOfFreePool}% of the free reward pool and at most ${F.epochRules.rateCapK}× the liquidity-adjusted value burned (×2 Orbit, ×3 Moon Landing). That keeps the pool from ever being emptied, and it means nobody can promise you an amount. We don’t.</p>`)}
${section('How to do it, step by step', `<ol>${F.steps.map((s) => `<li><strong>${esc(s.title)}.</strong> ${esc(s.text)}</li>`).join('')}</ol>`)}
${section('Verify it yourself', `<ul>${F.verifyChecklist.map((c) => `<li><strong>${esc(c.title)}.</strong> ${esc(c.text)}</li>`).join('')}</ul>`)}
${verifyBlock(F)}
${section('What Moon Forge will never do', `<ul>${li(F.never)}</ul><p class="muted">Official places only: this site, the GitHub repository and X @MoonXenForge. No chat group is official.</p>`)}
${section('Risks, plainly', `<ul>${li(F.risks)}</ul>`)}
<section id="faq"><h2>Questions people ask</h2>${faqHtml(F)}</section>
${noticesHtml(F)}
${rulesLine(F)}`;
}

function bodyFaq(F) {
    return `<h1>Questions people ask</h1>${faqHtml(F)}
${section('Not to be confused with', `<ul>${li(F.disambiguation)}</ul><p>${esc(F.oldBurns)}</p>`)}
${noticesHtml(F)}${rulesLine(F)}`;
}

function bodyArtifacts(F, alias) {
    const A = F.artifactRules;
    const I = F.INTERIM;
    // R6a: the same pause the React page shows (forge and Genesis claim buttons disabled), first thing on the page.
    const paused = I && (I.forgePaused || I.genesisClaimPaused)
        ? `<section><h2>Paused on this site (notice dated ${esc(I.noticeDate)})</h2><p><strong>${esc([I.forgePaused ? 'Forging Artifacts' : '', I.genesisClaimPaused ? 'the Genesis claim' : ''].filter(Boolean).join(' and ').replace(/^./, (c) => c.toUpperCase()))} ${I.forgePaused && I.genesisClaimPaused ? 'are' : 'is'} paused on this site until the final program upgrade (${esc(I.upgradeWhen)}).</strong> The buttons on this page are disabled; recycling an Artifact and the weekly chips claim stay open. The current Artifact rules described below are being replaced; what replaces them is published with the upgrade changelog, not before.</p></section>`
        : '';
    return `<h1>Artifacts</h1>${alias ? `<p class="muted">This address is an alias of <a href="${href('/artifacts/')}">/artifacts/</a>. Moon Forge runs no marketplace.</p>` : ''}
${paused}
<p>Metaplex Core NFTs minted by the Moon Forge program. Under the current rules each one can boost its holder’s burn score, grants weekly lottery chips, is a ticket to the Artifact Duel and Moon Wars arenas, and may hold an XNT floor you get back when you recycle it.</p>
${table(['Tier', 'Element', 'Max alive', 'Base price', 'Boost', 'Weekly chips'], F.artifacts.map((a) => [a.name, a.element, String(a.supply), `${a.basePriceXnt} XNT`, `+${a.boostPct}%`, String(a.weeklyChips)]))}
${section('Where the forge price goes', `<p>${F.forgeSplit.floorPct}% floor kept inside the NFT (given back on recycle), ${F.forgeSplit.poolPct}% reward pool (paid to burners), ${F.forgeSplit.lotteryPct}% Burn Lottery vault, ${F.forgeSplit.architectPct}% architect.</p>${p([A.pricing, A.floors, A.boost])}`)}
${section('Genesis airdrop', p([A.genesis]))}
${section('Trading', `${p([A.trading])}<p class="muted">Collection: <code>${esc(F.identity.collectionPda)}</code></p>`)}
${noticesHtml(F, ['forge-paused', 'genesis', 'forge-drops', 'rules-v2', 'upgrade-pending'])}${rulesLine(F)}`;
}

function bodyGames(F) {
    const G = F.gameRules;
    return `<h1>Games</h1><p>Every XNT game is an instruction of the Moon Forge program on X1. Part of every stake feeds the burners’ reward pool. Play only with amounts you can afford to lose: house games have a fixed ${F.fees.houseEdgePct}% edge (negative expected value) and the program is upgradeable during the test period.</p>
${table(['Game', 'Type', 'Rules', 'Status'], F.games.map((g) => [g.name, g.kind, g.summary, g.status]))}
${section('Fairness', p([G.randomness, G.settlement, G.circuitBreaker, G.sessionKeys]))}
${section('Fees', `<p>House edge ${F.fees.houseEdgePct}%: ${F.fees.edgeToPoolPct}% reward pool, ${F.fees.edgeToArchitectPct}% architect, ${F.fees.edgeToBankrollPct}% bankroll. P2P rake ${F.fees.p2pRakePct}% only when someone wins: ${F.fees.rakeToPoolPct}% pool, ${F.fees.rakeToArchitectPct}% architect, ${F.fees.rakeToDrawPct}% lottery. Burn Lottery tickets pay ${F.fees.p2pRakePct}% at purchase. Be the House withdrawals have a ${F.fees.houseWithdrawHours} h cooldown.</p>`)}
${noticesHtml(F, ['house-keeper', 'moon-wars-paused', 'predictions-off', 'upgrade-pending'])}${rulesLine(F)}`;
}

function bodyTransparency(F) {
    const I = F.identity;
    return `<h1>Transparency</h1><p>Live values (vaults, configuration, lifetime counters, epochs, the current upgrade authority) are read from X1 and need JavaScript. The fixed facts are below.</p>
${section('Program and accounts', `<ul><li>Program: <code>${esc(I.programId)}</code> on X1 mainnet (RPC <code>${esc(I.x1Rpc)}</code>), source tag <code>${esc(F.rules.program)}</code>, ${esc(I.license)} license.</li><li>Reward pool: <code>${esc(I.rewardVaultPda)}</code></li><li>Artifacts collection: <code>${esc(I.collectionPda)}</code></li><li>Architect wallet (upgrade authority during the test period; receives the disclosed cuts): <code>${esc(I.architectWallet)}</code></li><li>Burn portal on every supported chain: <code>${esc(I.portal)}</code></li></ul>`)}
${section('Every fee and split', table(['Item', 'Value'], [
        ['Burn → claim → vesting → withdrawal', `${F.fees.burnPathPct}%`],
        ['House edge', `${F.fees.houseEdgePct}% (${F.fees.edgeToPoolPct}% pool, ${F.fees.edgeToArchitectPct}% architect, ${F.fees.edgeToBankrollPct}% bankroll)`],
        ['P2P rake (Jackpot, Duel, Moon Wars), only when someone wins', `${F.fees.p2pRakePct}% (${F.fees.rakeToPoolPct}% pool, ${F.fees.rakeToArchitectPct}% architect, ${F.fees.rakeToDrawPct}% lottery)`],
        ['Burn Lottery ticket', `${F.fees.p2pRakePct}% at purchase; 50% of the vault to the winner`],
        ['Artifact forge price', `${F.forgeSplit.floorPct}% floor, ${F.forgeSplit.poolPct}% pool, ${F.forgeSplit.lotteryPct}% lottery, ${F.forgeSplit.architectPct}% architect`],
        ['Secondary royalty (where honored)', `${F.fees.secondaryRoyaltyPct}%`],
        ['Keeper tip (paid by the pool)', `${F.fees.keeperTipXnt} XNT per claim ≥ ${F.fees.keeperTipMinClaimXnt} XNT; ${F.fees.dropKeeperTipXnt} XNT per Forge Drop`],
        ['Eject penalty (to the pool)', F.tiers.filter((t) => t.penaltyPct).map((t) => `${t.name} ${t.penaltyPct}% of the unvested part`).join('; ')],
    ]))}
${section('Epoch rules', `<ul>${li([`Cadence: ${F.epochRules.cadence}; at least ${F.epochRules.minIntervalDays} days apart.`, F.epochRules.budgetLine, F.epochRules.scoring, F.epochRules.priceClamp, `Claims stay open ${F.epochRules.claimWindowDays} days.`])}</ul>`)}
${section('Tiers', table(['Tier', 'Multiplier', 'Paid', 'Eject early'], F.tiers.map((t) => [t.name, `${t.multiplier}×`, t.vestingDays ? `linear over ${t.vestingDays} days` : 'at claim', t.penaltyPct ? `${t.penaltyPct}% penalty on the unvested part` : '—'])))}
${section('Who can do what', `<ul>${li(F.trust)}</ul>`)}
${section('Source', `<ul><li><a href="${esc(F.officialLinks.programSource)}">Program source</a> · <a href="${esc(F.officialLinks.programConstants)}">constants.rs</a></li><li><a href="${esc(F.officialLinks.portalSource)}">MoonForgePortal.sol</a></li><li><a href="${esc(F.officialLinks.oracleSource)}">Oracle</a> · <a href="${esc(F.officialLinks.epochIndex)}">epoch files</a></li><li><a href="${esc(F.officialLinks.reviewMd)}">Internal review (not independent)</a> · <a href="${esc(F.officialLinks.securityMd)}">SECURITY.md</a></li></ul>`)}
${noticesHtml(F)}${rulesLine(F)}`;
}

function bodyWhitepaper(F) {
    return `<h1>Whitepaper v2</h1><p>${esc(F.identity.tagline)}. Zero protocol fees on the burn path. Verifiable by anyone. Full text: <a href="${esc(F.officialLinks.whitepaperMd)}">docs/WHITEPAPER.md</a>.</p>
${F.whitepaper.map((s, i) => section(`${i + 1}. ${s.title}`, p(s.paragraphs))).join('')}
${noticesHtml(F, ['rules-v2', 'forge-drops'])}${rulesLine(F)}`;
}

function bodyApp(F, route) {
    const extra = route.path === '/forge/'
        ? `<p>${esc(F.oldBurns)}</p><p>Before signing: the burn is irreversible, your only cost is gas on that chain, Moon Forge takes no fee on this path, and the burn transaction links your EVM address to your X1 address publicly and forever.</p>`
        : route.path === '/donate/' ? `<p>Donations go to the reward pool <code>${esc(F.identity.rewardVaultPda)}</code>; 100% reaches burners through the weekly budget (at most ${F.epochRules.budgetPctOfFreePool}% of the free pool per epoch). Nothing is taken on the way.</p>`
            : `<p>Claims stay open ${F.epochRules.claimWindowDays} days after an epoch is published; the public keeper usually submits them. Vested XNT is pushed with "Withdraw vested".</p>`;
    return `<h1>${esc(route.title.replace(/ \|.*$/, ''))}</h1><p>${esc(route.description)}</p>${extra}<p class="muted">This page needs JavaScript and a wallet. New here? Read <a href="${href('/start/')}">Start here</a> first.</p>${rulesLine(F)}`;
}

function bodyFor(F, route) {
    switch (route.path) {
        case '/': return bodyHome(F);
        case '/start/': return bodyStart(F);
        case '/faq/': return bodyFaq(F);
        case '/artifacts/': return bodyArtifacts(F, false);
        case '/nft/': case '/marketplace/': return bodyArtifacts(F, true);
        case '/games/': return bodyGames(F);
        case '/transparency/': return bodyTransparency(F);
        case '/whitepaper/': return bodyWhitepaper(F);
        default: return bodyApp(F, route);
    }
}

// ── head: title, description, canonical, social, JSON-LD ─────────────────────
function jsonLd(F, route, site) {
    const I = F.identity; const L = F.officialLinks;
    const org = { '@type': 'Organization', '@id': `${site}#org`, name: I.legalName, url: site, logo: `${site}moon-icon.svg`, sameAs: [L.github, L.x] };
    const website = { '@type': 'WebSite', '@id': `${site}#website`, name: I.name, url: site, inLanguage: 'en', publisher: { '@id': `${site}#org` } };
    const app = {
        '@type': 'SoftwareApplication', '@id': `${site}#app`, name: I.name, url: site, applicationCategory: 'FinanceApplication', operatingSystem: 'Web',
        isAccessibleForFree: true, softwareVersion: F.rules.program, license: I.licenseUrl, description: I.description,
        identifier: [
            { '@type': 'PropertyValue', propertyID: 'x1-program', value: I.programId },
            { '@type': 'PropertyValue', propertyID: 'evm-burn-portal', value: I.portal },
            { '@type': 'PropertyValue', propertyID: 'artifacts-collection', value: I.collectionPda },
        ],
        publisher: { '@id': `${site}#org` },
    };
    const code = { '@type': 'SoftwareSourceCode', '@id': `${site}#source`, name: `${I.name} source`, codeRepository: L.github, license: I.licenseUrl, programmingLanguage: [...I.languages], targetProduct: { '@id': `${site}#app` } };
    const canonical = abs(route.canonical ?? route.path, site);
    const page = { '@type': 'WebPage', '@id': canonical, url: canonical, name: route.title, description: route.description, inLanguage: 'en', isPartOf: { '@id': `${site}#website` }, about: { '@id': `${site}#app` } };
    const graph = [org, website, app, code, page];
    if (route.path === '/start/' || route.path === '/faq/') {
        graph.push({ '@type': 'FAQPage', '@id': `${canonical}#faq`, url: canonical, mainEntity: F.faq.map((f) => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a } })) });
    }
    return JSON.stringify({ '@context': 'https://schema.org', '@graph': graph }).replace(/<\//g, '<\\/');
}

function headFor(F, route, site, { notFound = false } = {}) {
    const canonical = abs(route.canonical ?? route.path, site);
    const image = `${site}nft/images/void_anomaly/event_horizon.jpg`;
    const robots = notFound || !route.index ? '<meta name="robots" content="noindex" />\n    ' : '';
    return `<!-- seo:start (generated by scripts/prerender.mjs from src/facts.ts; do not edit by hand) -->
    <title>${esc(route.title)}</title>
    <meta name="description" content="${esc(route.description)}" />
    ${robots}${notFound ? '' : `<link rel="canonical" href="${canonical}" />\n    `}<meta property="og:site_name" content="Moon Forge" />
    <meta property="og:type" content="website" />
    <meta property="og:title" content="${esc(route.title)}" />
    <meta property="og:description" content="${esc(route.description)}" />
    <meta property="og:url" content="${canonical}" />
    <meta property="og:image" content="${image}" />
    <meta property="og:locale" content="en_US" />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:site" content="@MoonXenForge" />
    <meta name="twitter:title" content="${esc(route.title)}" />
    <meta name="twitter:description" content="${esc(route.description)}" />
    <meta name="twitter:image" content="${image}" />
    <script type="application/ld+json">${jsonLd(F, route, site)}</script>
    <!-- seo:end -->`;
}

function pageHtml(F, template, route, site, opts = {}) {
    const head = headFor(F, route, site, opts);
    const SEO = /<!-- seo:start[\s\S]*?<!-- seo:end -->/;
    if (!SEO.test(template)) throw new Error('index.html has no <!-- seo:start --> … <!-- seo:end --> block');
    if (!template.includes('<div id="root"></div>')) throw new Error('index.html has no empty <div id="root"></div>');
    // The "/" block may already be byte-identical to the template (synced by --write-public), so presence is tested above, not the result of the replace.
    const html = template.replace(SEO, () => head);
    const body = `<div class="prerender" data-prerender="${esc(route.path)}"><noscript><p class="muted">JavaScript is off: this is the static copy of the page. Live numbers and wallet actions need JavaScript.</p></noscript>${nav(F)}${bodyFor(F, route)}</div>`;
    return html.replace('<div id="root"></div>', () => `${STYLE}<div id="root">${body}</div>`);
}

// ── llms.txt / llms-full.txt / sitemap.xml ───────────────────────────────────
function llmsTxt(F) {
    const I = F.identity; const L = F.officialLinks; const site = L.site;
    return `# Moon Forge

> ${I.description}

Program: ${I.programId} (X1 mainnet, RPC ${I.x1Rpc}; source tag ${F.rules.program}). Burn portals: ${I.portal} (the same address on ${F.liveChains.map((c) => c.name).join(', ')}; Ethereum and PulseChain have no portal). Artifacts collection: ${I.collectionPda}. Upgradeable during the public test period; no third-party audit (internal reviews are public). ${F.disambiguation[0]} ${F.disambiguation[1]}

${F.oldBurns}

Rules described: program tag ${F.rules.program}, oracle ${F.rules.oracle}, valid from ${F.rules.validFrom} (texts checked on ${F.rules.describedAsOf}). Dated notices: ${F.notices.map((n) => `${n.id} (${n.date})`).join(', ')}; see llms-full.txt.

## Start
- [Start here](${site}start/): how to burn XEN for XNT step by step, verify-it-yourself checklist, FAQ
- [FAQ](${site}faq/): the questions people ask, including old burns, XEN Prime, X1 Forge and the Genesis airdrop
- [Transparency](${site}transparency/): program and upgrade authority, vaults, who can do what, every fee
- [Whitepaper](${site}whitepaper/): scoring, budget, tiers, games, Artifacts, trust model (full text: ${L.whitepaperMd})
- [Full facts for AI readers](${L.llmsFull}): llms-full.txt

## For AI agents
- [Skill file](${L.skillFile}): rules, costs, workflows and guardrails
- [Agent kit](${L.agentKit}): JavaScript client, examples and an end-to-end test
- [Agent card](${L.agentCard}): ERC-8004 registration format
- [Epoch files](${L.epochIndex}): every published epoch, recomputable with \`cd oracle && npm run verify -- epoch-N.json --full\`

## Key rules (rules 2, live)
- Burn payout: share of the weekly epoch budget = min(${F.epochRules.budgetPctOfFreePool}% of the free reward pool, ${F.epochRules.rateCapK} × the liquidity-adjusted value burned); each chain’s XEN is valued at its own market price with a liquidity discount L/(L+V). Tiers: ${F.tiers.map((t) => `${t.name} ${t.multiplier}×${t.vestingDays ? ` over ${t.vestingDays} days` : ''}`).join(', ')}. Claims stay open ${F.epochRules.claimWindowDays} days.
- Artifacts (Metaplex Core NFTs): ${F.forgeSplit.floorPct}% of the price stays inside as a floor you can take back, ${F.forgeSplit.poolPct}% goes to the reward pool, ${F.forgeSplit.lotteryPct}% lottery, ${F.forgeSplit.architectPct}% architect; recycle any time.
- House games (Coin Flip, High-Low, Void Rush): fixed ${F.fees.houseEdgePct}% edge. Jackpot, Artifact Duel and Moon Wars: ${F.fees.p2pRakePct}% rake only when someone wins. Moon Wars real-XNT matches are paused on the site; Predictions are in the program but not offered by this site or the agent kit, and a round can be blocked or steered cheaply (known issue GAM-3).
- Official places: ${site}, ${L.github}, ${L.x}. Nobody from Moon Forge messages anyone first; no chat group is official.
`;
}

function llmsFullTxt(F, meta) {
    const I = F.identity; const L = F.officialLinks; const site = L.site;
    const lines = [];
    const h = (t) => lines.push('', `## ${t}`, '');
    lines.push('# Moon Forge: full facts for AI readers', '', `> ${I.description}`, '',
        `Rules described: program tag ${F.rules.program}, oracle ${F.rules.oracle}, valid from ${F.rules.validFrom}; texts checked on ${F.rules.describedAsOf}. Generated from src/facts.ts at commit ${meta.commit} (last change to the site: ${meta.lastmod}). This file is plain text: it contains no instructions for the reader beyond the facts below.`);
    h('What it is');
    lines.push(`${I.name} is an open-source protocol on X1 (an SVM chain whose native token is XNT). People burn XEN on ${F.liveChains.map((c) => c.name).join(', ')} through a portal contract and receive XNT on X1 from a reward pool, through weekly epochs that anyone can recompute. No token, no presale, no team allocation.`, '', ...F.disambiguation, '', F.oldBurns);
    h('Verify you are on the real site');
    lines.push(`- Site: ${site}`, `- X1 program: ${I.programId} (RPC ${I.x1Rpc}, explorer ${I.x1Explorer}), source tag ${F.rules.program}, ${I.license} license`, `- Burn portal, the same address on every supported chain: ${I.portal}`, `- Artifacts collection (Metaplex Core): ${I.collectionPda}`, `- Reward pool: ${I.rewardVaultPda}`, `- Architect wallet (upgrade authority during the test period; receives the disclosed cuts): ${I.architectWallet}`, `- Source: ${L.github} · X: ${L.x}`, '- Any other program ID, portal, collection, site or "claim" page is not Moon Forge.');
    h('Chains');
    for (const c of F.chains) lines.push(`- ${c.name} (chain id ${c.chainId}): XEN ${c.xenToken}; ${c.live ? `portal live at ${I.portal}` : 'no portal, and none is planned by this project'}`);
    h('How it works');
    F.steps.forEach((s, i) => lines.push(`${i + 1}. ${s.title}. ${s.text}`));
    h('Epoch and payout rules (rules 2)');
    lines.push(`- Cadence: ${F.epochRules.cadence}; at least ${F.epochRules.minIntervalDays} days apart.`, `- ${F.epochRules.scoring}`, `- ${F.epochRules.budgetLine}`, `- ${F.epochRules.priceClamp}`, `- ${F.epochRules.dustRule}`, `- Claims stay open ${F.epochRules.claimWindowDays} days; then the rest goes back to the pool.`, `- An epoch pays at most ${F.epochRules.rateCapK}× / ${F.epochRules.rateCapK * 2}× / ${F.epochRules.rateCapK * 3}× the liquidity-adjusted market value burned (Launchpad / Orbit / Moon Landing). Nobody can promise an amount: what a week pays depends on the pool and on how much others burn.`);
    h('Tiers and vesting');
    for (const t of F.tiers) lines.push(`- ${t.name}: ${t.multiplier}×, ${t.vestingDays ? `linear vesting over ${t.vestingDays} days, ${t.penaltyPct}% penalty on the unvested part if ejected early (to the pool)` : 'paid at claim'}`);
    h('Fees and splits (compile-time constants of the program)');
    lines.push(`- Burn → claim → vesting → withdrawal: ${F.fees.burnPathPct}%`, `- House edge: ${F.fees.houseEdgePct}% (${F.fees.edgeToPoolPct}% reward pool, ${F.fees.edgeToArchitectPct}% architect, ${F.fees.edgeToBankrollPct}% bankroll)`, `- P2P rake (Jackpot, Artifact Duel, Moon Wars), only when someone wins: ${F.fees.p2pRakePct}% (${F.fees.rakeToPoolPct}% pool, ${F.fees.rakeToArchitectPct}% architect, ${F.fees.rakeToDrawPct}% lottery)`, `- Burn Lottery ticket: ${F.fees.p2pRakePct}% at purchase; the winner gets 50% of the vault`, `- Artifact forge price: ${F.forgeSplit.floorPct}% floor kept inside the NFT, ${F.forgeSplit.poolPct}% reward pool, ${F.forgeSplit.lotteryPct}% lottery, ${F.forgeSplit.architectPct}% architect`, `- Secondary royalty where honored: ${F.fees.secondaryRoyaltyPct}%`, `- Keeper tips, paid by the pool: ${F.fees.keeperTipXnt} XNT per claim ≥ ${F.fees.keeperTipMinClaimXnt} XNT; ${F.fees.dropKeeperTipXnt} XNT per Forge Drop`, `- A bet can win at most ${F.fees.maxExposurePct}% of the free bankroll; unsettled payouts stay under ${F.fees.maxTotalExposurePct}% of it; daily circuit breaker at ${F.fees.maxDailyLossPct}%`);
    h('Artifacts (Metaplex Core NFTs)');
    for (const a of F.artifacts) lines.push(`- ${a.name} (${a.element}): max ${a.supply} alive, base price ${a.basePriceXnt} XNT, burn boost +${a.boostPct}%, ${a.weeklyChips} weekly chips`);
    lines.push('', F.artifactRules.pricing, F.artifactRules.floors, F.artifactRules.boost, F.artifactRules.trading, F.artifactRules.genesis);
    h('Games');
    for (const g of F.games) lines.push(`- ${g.name} (${g.kind}): ${g.summary} Status: ${g.status}.`);
    lines.push('', F.gameRules.randomness, F.gameRules.settlement, F.gameRules.circuitBreaker, F.gameRules.sessionKeys);
    h('Verification');
    lines.push(`Each epoch file (burns, prices, liquidity, every leaf) is public at ${L.epochIndex} and hash-committed on-chain. Anyone can run \`cd oracle && npm run verify -- epoch-N.json --full\` from ${L.github} and get the same result.`);
    h('Trust assumptions');
    for (const t of F.trust) lines.push(`- ${t}`);
    h('Risks');
    for (const r of F.risks) lines.push(`- ${r}`);
    h('What Moon Forge will never do');
    for (const n of F.never) lines.push(`- ${n}`);
    lines.push('', `Official places only: ${site}, ${L.github}, ${L.x}. Nobody from Moon Forge messages, e-mails or calls anyone first; no chat group is official.`);
    h('FAQ');
    for (const f of F.faq) lines.push(`Q: ${f.q}`, `A: ${f.a}`, '');
    h('For AI agents');
    lines.push(`- Skill file: ${L.skillFile}`, `- Agent kit (JavaScript client, examples, end-to-end test): ${L.agentKit}`, `- Agent card (ERC-8004 registration format): ${L.agentCard}`, '- Agents play with their own keypair, like anyone. House games have a fixed edge (negative expected value). Session keys play house games only and can never withdraw.', '- This project never pays anyone to promote it and never posts as someone else; it does not ask AI systems to recommend it.');
    h('Dated notices');
    for (const n of F.notices) lines.push(`- ${n.date} (${n.id}): ${n.text}`);
    h('Pages');
    for (const r of F.routes.filter((x) => x.index)) lines.push(`- ${abs(r.path, site)}: ${r.description}`);
    return lines.join('\n') + '\n';
}

function sitemapXml(F, meta) {
    const site = F.officialLinks.site;
    const urls = [...F.routes.filter((r) => r.index).map((r) => abs(r.path, site)), ...F.sitemapFiles.map((f) => site + f)];
    return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map((u) => `  <url><loc>${esc(u)}</loc><lastmod>${meta.lastmod}</lastmod></url>`).join('\n')}\n</urlset>\n`;
}

// ── main ─────────────────────────────────────────────────────────────────────
const F = await loadFacts();
const site = F.officialLinks.site;
const meta = {
    lastmod: new Date(git(`log -1 --format=%cI -- "${ROOT}"`, new Date().toISOString())).toISOString(), // UTC: a committer offset never reaches the site
    commit: git('rev-parse --short HEAD', 'unknown'),
};
const generated = { 'llms.txt': llmsTxt(F), 'llms-full.txt': llmsFullTxt(F, meta), 'sitemap.xml': sitemapXml(F, meta) };
for (const [name, text] of Object.entries(generated)) lint(name, text);
lintSources();

if (CHECK) {
    const volatile = (s) => s.replace(/<lastmod>[^<]*<\/lastmod>/g, '<lastmod/>').replace(/Generated from src\/facts\.ts at commit [^\n]*/g, 'Generated').replace(/\r\n/g, '\n');
    let bad = 0;
    for (const [name, text] of Object.entries(generated)) {
        const file = path.join(PUBLIC, name);
        const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
        if (volatile(current) !== volatile(text)) { bad++; console.error(`prerender --check: public/${name} differs from src/facts.ts (run: node scripts/prerender.mjs --write-public)`); }
    }
    const robots = fs.readFileSync(path.join(PUBLIC, 'robots.txt'), 'utf8');
    if (!robots.includes(`Sitemap: ${site}sitemap.xml`)) { bad++; console.error('prerender --check: public/robots.txt has no Sitemap line'); }
    const srcHtml = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    const block = srcHtml.match(/<!-- seo:start[\s\S]*?<!-- seo:end -->/);
    if (!block || volatile(block[0]) !== volatile(headFor(F, F.routes[0], site))) { bad++; console.error('prerender --check: the seo block of index.html differs from facts.ts (run: node scripts/prerender.mjs --write-public)'); }
    if (bad) process.exit(1);
    console.log('prerender --check: public/ files and the index.html seo block match src/facts.ts');
    process.exit(0);
}

if (WRITE_PUBLIC) {
    for (const [name, text] of Object.entries(generated)) fs.writeFileSync(path.join(PUBLIC, name), text);
    const srcPath = path.join(ROOT, 'index.html');
    const srcHtml = fs.readFileSync(srcPath, 'utf8');
    const synced = srcHtml.replace(/<!-- seo:start[\s\S]*?<!-- seo:end -->/, () => headFor(F, F.routes[0], site));
    if (synced === srcHtml && !srcHtml.includes('<!-- seo:start')) throw new Error('index.html has no seo block');
    fs.writeFileSync(srcPath, synced);
    console.log(`prerender: wrote ${Object.keys(generated).map((n) => `public/${n}`).join(', ')} and the index.html seo block`);
    process.exit(0);
}

const templatePath = path.join(DIST, 'index.html');
if (!fs.existsSync(templatePath)) { console.error('prerender: dist/index.html not found; run `vite build` first'); process.exit(1); }
const template = fs.readFileSync(templatePath, 'utf8');
if (/fonts\.googleapis|fonts\.gstatic/.test(template)) console.warn('prerender: WARNING dist/index.html still references Google Fonts (anonymity rule: self-host them, T9-29)');

let written = 0;
for (const route of F.routes) {
    const html = pageHtml(F, template, route, site);
    lint(`${route.path}index.html`, html.replace(/<script type="module"[\s\S]*?<\/script>|<link rel="(stylesheet|modulepreload)"[^>]*>/g, ''));
    const dir = path.join(DIST, route.path.replace(/^\//, ''));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'index.html'), html);
    written++;
}
fs.writeFileSync(path.join(DIST, '404.html'), pageHtml(F, template, { ...F.routes[0], title: 'Page not found | Moon Forge', description: F.identity.description }, site, { notFound: true }));
for (const [name, text] of Object.entries(generated)) fs.writeFileSync(path.join(DIST, name), text);
const robots = fs.readFileSync(path.join(DIST, 'robots.txt'), 'utf8');
if (!robots.includes(`Sitemap: ${site}sitemap.xml`)) { console.error('prerender: dist/robots.txt has no Sitemap line'); process.exit(1); }
console.log(`prerender: ${written} routes + 404.html, llms.txt, llms-full.txt, sitemap.xml written to dist/ (rules ${F.rules.oracle}, tag ${F.rules.program}, lastmod ${meta.lastmod})`);
