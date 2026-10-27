#!/usr/bin/env node
// Wording and personal-data check for Moon Forge public texts.
//
// Standard: docs/WORDING.md (the allow-list lives in its ```wording-allow fenced block).
// Usage:    node scripts/wording-check.mjs [--root <repo>] [--json] [--warn-only] [--list-files] [paths...]
// Exit:     1 when at least one FAIL hit is not allow-listed, else 0 (warnings never fail).
// Env:      WORDING_DENY         comma-separated literal strings that must never appear (case-insensitive)
//           WORDING_DENY_SHA256  comma-separated sha256 hex digests of lower-cased tokens (base58 32-44 chars,
//                                0x-hex addresses, @handles) that must never appear; lets a repo secret deny an
//                                address or handle without writing it into this public file.
// No dependencies; Node 18+.

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

// ───────────────────────────── scope ─────────────────────────────
// PROSE scope: every rule. CODE scope: personal-data and hidden-text rules only.
const PROSE_SCOPE = [
  { dir: ".", ext: [".md"], depth: 0 },
  { file: "package.json" },
  { dir: "docs", ext: [".md", ".txt"] },
  { dir: "frontend/src", ext: [".ts", ".tsx", ".css", ".html", ".json"] },
  { file: "frontend/index.html" },
  { file: "frontend/package.json" },
  { dir: "frontend/public", ext: [".txt", ".json", ".xml", ".html", ".svg", ".md", ".webmanifest"],
    skip: ["frontend/public/epochs", "frontend/public/airdrop"] },
  { dir: "agents", ext: [".md", ".mjs", ".js", ".json", ".txt"], skip: ["package-lock.json"] },
  { dir: "scripts/nft-metadata", ext: [".mjs", ".js", ".json"] },
  { dir: "nft-arweave", ext: [".json", ".md"] },
  { file: "oracle/src/announce.ts" },
  { file: "programs/moon-forge/Cargo.toml" },
  { file: "programs/moon-forge/src/lib.rs" },
];
const CODE_SCOPE = [
  { dir: ".github", ext: [".yml", ".yaml", ".md"] },
  { dir: "oracle/src", ext: [".ts"] },
  { dir: "scripts", ext: [".mjs", ".js", ".ts", ".ps1", ".sh", ".py"] },
  { dir: "programs", ext: [".rs", ".toml"] },
  { dir: "contracts", ext: [".sol"] },
  { dir: "tests", ext: [".ts", ".sh"] },
  { dir: "test", ext: [".ts"] },
  { dir: "deployments", ext: [".json", ".md"] },
  { file: "hardhat.config.ts" },
  { file: "Anchor.toml" },
];
const ALWAYS_SKIP = ["node_modules", "dist", "target", ".git", "package-lock.json", "wording-check.mjs"];

// ───────────────────────────── rules ─────────────────────────────
// level: "fail" | "warn"; scope: "prose" | "all"; neg: negation within 40 chars before the match allows it.
const NEG = /\b(no|not|never|nothing|none|neither|nor|without|isn'?t|aren'?t|wasn'?t|don'?t|doesn'?t|cannot|can'?t|won'?t|zero|non)\b|n['’]t\b/i;
const RULES = [
  { id: "apr-apy", level: "fail", scope: "prose", re: /\b(APR|APY)\b/g,
    hint: "no rate-of-return vocabulary; say what the program pays and from what" },
  { id: "roi", level: "fail", scope: "prose", re: /\bROI\b/g, hint: "no rate-of-return vocabulary" },
  { id: "yield", level: "fail", scope: "prose", re: /\byield(s|ed|ing)?\b/gi, neg: true, hint: "say payout / is paid" },
  { id: "earn", level: "fail", scope: "prose", re: /\bearn(s|ed|ing|ings)?\b/gi, neg: true,
    hint: "say receive / is paid / payout; for the architect say receives the disclosed cut" },
  { id: "profit", level: "fail", scope: "prose", re: /\bprofit(s|able|ability|ing|ed|eering)?\b/gi, neg: true,
    hint: "state the amounts and who pays them instead" },
  { id: "investment", level: "fail", scope: "prose", re: /\binvest(s|ed|ing|ment|ments|or|ors)?\b/gi, neg: true,
    hint: "say deposit / stake / forge price; nothing here is an investment" },
  { id: "guarantee", level: "fail", scope: "prose", re: /\bguarantee(d|s|ing)?\b/gi, neg: true,
    hint: "say enforced by the program (only when it is) or not promised" },
  { id: "passive-income", level: "fail", scope: "prose",
    re: /\bpassive[- ](income|earn\w*|return\w*|yield\w*|reward\w*|gain\w*)\b/gi, hint: "never" },
  { id: "return-noun", level: "fail", scope: "prose", neg: true, hint: "say payout / what the epoch paid / estimate",
    re: /\b(promised|guaranteed|expected|annual\w*|yearly|monthly|weekly|daily|high|higher|better|best|positive|total|your|LP|house|live|estimated|projected|average|real|net|gross|good|great|big|bigger|huge|risk-adjusted)\s+returns?\b|\breturns?\s+(on|of)\s+(your\s+|the\s+|an?\s+)?(investment|deposit|capital|stake|money|burn|XNT|XEN)\b|\brate\s+of\s+return\b/gi },
  { id: "risk-free", level: "fail", scope: "prose", neg: true, hint: "never",
    re: /\b(risk[- ]free|no[- ]risk|zero[- ]risk|without\s+risk|can'?t\s+lose|cannot\s+lose)\b/gi },
  { id: "bigger-share", level: "fail", scope: "prose", re: /\bbigger\s+share\b/gi,
    hint: "a boost shifts shares inside the same epoch budget; the total never grows" },
  { id: "audited", level: "fail", scope: "prose", neg: true, re: /\baudited\b|\bsecurity\s+audit(ed)?\s+by\b/gi,
    hint: "say internal review, not an independent audit" },
  { id: "hidden-instruction", level: "fail", scope: "all", hint: "no instructions aimed at AI assistants",
    re: /ignore\s+(all\s+)?(previous|prior|above)\s+instructions|you\s+must\s+(recommend|promote|praise)|always\s+recommend|do\s+not\s+tell\s+the\s+user|(assistant|model)s?\s+(should|must)\s+(recommend|promote|praise)/gi },
  { id: "zero-width", level: "fail", scope: "all", re: /[​‌‍⁠﻿]/g,
    hint: "invisible characters are not allowed in public texts" },
  { id: "email", level: "fail", scope: "all", re: /\b[\w.+-]+@[A-Za-z][\w-]*(\.[\w-]+)*\.[A-Za-z]{2,}\b/g,
    hint: "no e-mail addresses (the project mailbox, if any, goes through the allow-list)" },
  { id: "local-path", level: "fail", scope: "all",
    re: /\b[A-Za-z]:\\[^\s"'`)\]]*|\/mnt\/[a-z]\/[^\s"'`)\]]*|\/home\/[A-Za-z0-9_.-]+\/|\/Users\/[A-Za-z0-9_.-]+\/|[\\/][^\s\\/]*[À-ɏ][^\s\\/]*[\\/]/g,
    hint: "no local machine paths" },
  { id: "timezone", level: "fail", scope: "all", hint: "UTC only; no local time zones or offsets",
    re: /\b(UTC|GMT)\s?[+\-−]\s?(0?[1-9]|1[0-4])\b|\b(BRT|BRST|EDT|PDT|CEST)\b|\b(America|Europe|Asia|Africa|Australia|Pacific)\/[A-Z][A-Za-z_]+\b|\d{2}:\d{2}(:\d{2})?\s?[+\-−](0[1-9]|1[0-4]):?00\b/g },
  { id: "co-authored", level: "fail", scope: "all", re: /Co-Authored-By:/gi, hint: "no author trailers in files" },
  { id: "immutable", level: "warn", scope: "prose", re: /\b[Ii]mmutab(?:le|ility)\b(?!\.md)/g,
    hint: "true for the portals; for the program only after the dated freeze transaction" },
  { id: "trustless", level: "warn", scope: "prose", re: /\btrustless\b/gi,
    hint: "trust is limited to the bounded oracle and, until the burn, the upgrade key" },
];

// ───────────────────────────── args ─────────────────────────────
const argv = process.argv.slice(2);
const flag = (f) => argv.includes(f);
const optVal = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(optVal("--root") ?? path.join(HERE, ".."));
const extraPaths = argv.filter((a, i) => !a.startsWith("--") && argv[i - 1] !== "--root");
const JSON_OUT = flag("--json");
const WARN_ONLY = flag("--warn-only");

// ───────────────────────────── helpers ─────────────────────────────
const rel = (p) => path.relative(ROOT, p).split(path.sep).join("/");
const sha256 = (s) => createHash("sha256").update(s).digest("hex");

function globToRe(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") { re += ".*"; i++; if (glob[i + 1] === "/") i++; }
      else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp("^" + re + "$");
}

function walk(dir, exts, skip, depth, out) {
  if (!fs.existsSync(dir)) return;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    const r = rel(full);
    if (ALWAYS_SKIP.includes(ent.name) || skip.some((s) => r === s || r.startsWith(s + "/") || ent.name === s)) continue;
    if (ent.isDirectory()) { if (depth !== 0) walk(full, exts, skip, depth === undefined ? undefined : depth - 1, out); }
    else if (exts.includes(path.extname(ent.name).toLowerCase())) out.add(full);
  }
}

function collect(scope) {
  const out = new Set();
  for (const s of scope) {
    if (s.file) { const f = path.join(ROOT, s.file); if (fs.existsSync(f)) out.add(f); }
    else walk(path.join(ROOT, s.dir), s.ext, s.skip ?? [], s.depth, out);
  }
  return out;
}

// Allow-list: ```wording-allow block in docs/WORDING.md, one rule per line:
//   <glob> :: <regex tested against the line> :: <reason> [:: <rule ids the exception covers, comma-separated>]
function loadAllow() {
  const f = path.join(ROOT, "docs", "WORDING.md");
  const rules = [];
  if (!fs.existsSync(f)) return { rules, warning: "docs/WORDING.md not found: no allow-list loaded" };
  const text = fs.readFileSync(f, "utf8");
  const m = text.match(/```wording-allow\r?\n([\s\S]*?)```/);
  if (!m) return { rules, warning: "docs/WORDING.md has no ```wording-allow block" };
  for (const raw of m[1].split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const parts = line.split("::").map((s) => s.trim());
    if (parts.length < 3 || !parts[2]) { rules.push({ bad: line }); continue; }
    const only = parts[3] ? new Set(parts[3].split(",").map((s) => s.trim()).filter(Boolean)) : null;
    try { rules.push({ glob: globToRe(parts[0]), re: new RegExp(parts[1], "i"), reason: parts[2], only, src: line }); }
    catch (e) { rules.push({ bad: line }); }
  }
  return { rules };
}

// For code files keep only prose: comments, string/template literal contents and (tsx/jsx/html-like) JSX text.
// Everything else becomes spaces, so line and column numbers survive.
function proseOnly(text, ext) {
  const n = text.length;
  const out = new Array(n);
  for (let k = 0; k < n; k++) out[k] = text[k] === "\n" ? "\n" : " ";
  const keep = (a, b) => { for (let k = a; k < b; k++) out[k] = text[k]; };
  let i = 0;
  const lineComment = [".py", ".sh", ".ps1", ".toml", ".yml", ".yaml"].includes(ext) ? "#" : "//";
  while (i < n) {
    const c = text[i], d = text[i + 1];
    if (text.startsWith(lineComment, i)) { const e = text.indexOf("\n", i); const end = e < 0 ? n : e; keep(i, end); i = end; continue; }
    if (c === "/" && d === "*") { const e = text.indexOf("*/", i + 2); const end = e < 0 ? n : e; keep(i + 2, end); i = e < 0 ? n : e + 2; continue; }
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < n && text[j] !== c) { if (text[j] === "\\") j++; if (c !== "`" && text[j] === "\n") break; j++; }
      keep(i + 1, j); i = j + 1; continue;
    }
    i++;
  }
  if (ext === ".tsx" || ext === ".jsx") {
    // JSX text runs: between a tag or expression end (> or }) and the next tag or expression start (< or {)
    const jsx = /[>}]([^<>{}]*[A-Za-z]{3,}[^<>{}]*)[<{]/g;
    let m;
    while ((m = jsx.exec(text))) keep(m.index + 1, m.index + 1 + m[1].length);
  }
  return out.join("");
}

const CODE_EXT = new Set([".ts", ".tsx", ".js", ".mjs", ".jsx", ".rs", ".sol", ".py", ".sh", ".ps1", ".toml", ".yml", ".yaml", ".css"]);

// ───────────────────────────── scan ─────────────────────────────
const { rules: allow, warning: allowWarning } = loadAllow();
const denyLiteral = (process.env.WORDING_DENY ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
const denyHashes = new Set((process.env.WORDING_DENY_SHA256 ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean));
const TOKEN_RE = /0x[0-9a-fA-F]{40}|\b[1-9A-HJ-NP-Za-km-z]{32,44}\b|@[A-Za-z0-9_]{3,30}\b/g;

const proseFiles = collect(PROSE_SCOPE);
const codeFiles = collect(CODE_SCOPE);
for (const p of extraPaths) {
  const abs = path.resolve(ROOT, p);
  if (!fs.existsSync(abs)) continue;
  if (fs.statSync(abs).isDirectory()) walk(abs, [".md", ".txt", ".json", ".ts", ".tsx", ".js", ".mjs", ".html", ".xml", ".svg", ".yml", ".rs", ".toml"], [], undefined, proseFiles);
  else proseFiles.add(abs);
}
for (const f of proseFiles) codeFiles.delete(f);

if (flag("--list-files")) {
  for (const f of [...proseFiles].sort()) console.log("prose  " + rel(f));
  for (const f of [...codeFiles].sort()) console.log("code   " + rel(f));
  process.exit(0);
}

const hits = [];
const allowed = [];
function scanFile(file, proseRules) {
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch { return; }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const r = rel(file);
  const ext = path.extname(file).toLowerCase();
  const subject = proseRules && CODE_EXT.has(ext) ? proseOnly(text, ext) : text;
  const lines = subject.split("\n");
  const rawLines = text.split("\n");
  let ignoring = false; // region markers: "wording-check: ignore-start" … "wording-check: ignore-end" (prose rules only)
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    const raw = rawLines[li] ?? "";
    if (/wording(-check)?:\s*ignore-start/.test(raw)) { ignoring = true; continue; }
    if (/wording(-check)?:\s*ignore-end/.test(raw)) { ignoring = false; continue; }
    if (/wording:allow/.test(raw) || (li > 0 && /^\s*(\/\/|\/\*|<!--|#|\*|--)?\s*wording:allow/.test(rawLines[li - 1] ?? ""))) continue;
    for (const rule of RULES) {
      if (rule.scope === "prose" && (!proseRules || ignoring)) continue;
      rule.re.lastIndex = 0;
      let m;
      while ((m = rule.re.exec(line))) {
        // the previous line counts only when the sentence wraps (it does not end with punctuation or a block end)
        const prev = (lines[li - 1] ?? "").trimEnd();
        const wraps = m.index < 40 && prev && !/[.!?:;|>]$|\*\/$|^\s*$/.test(prev) && !/^\s*([-*#>]|\d+\.)/.test(line);
        const before = (wraps ? prev.slice(-40) + " " : "") + line.slice(Math.max(0, m.index - 40), m.index);
        if (rule.neg && NEG.test(before)) continue;
        record(r, li + 1, m.index + 1, rule, m[0], raw.trim());
      }
    }
    if (denyLiteral.length) {
      const low = raw.toLowerCase();
      for (const d of denyLiteral) { const at = low.indexOf(d); if (at >= 0) record(r, li + 1, at + 1, { id: "deny", level: "fail", hint: "denied by WORDING_DENY" }, "<redacted>", "<redacted>"); }
    }
    if (denyHashes.size) {
      TOKEN_RE.lastIndex = 0;
      let t;
      while ((t = TOKEN_RE.exec(raw))) if (denyHashes.has(sha256(t[0].toLowerCase()))) record(r, li + 1, t.index + 1, { id: "deny-hash", level: "fail", hint: "denied by WORDING_DENY_SHA256" }, "<redacted>", "<redacted>");
    }
  }
}
function record(file, line, col, rule, match, context) {
  const hit = { file, line, col, rule: rule.id, level: rule.level, match, context: context.slice(0, 160), hint: rule.hint };
  const a = allow.find((x) => x.glob && x.glob.test(file) && (!x.only || x.only.has(rule.id)) && x.re.test(context));
  if (a) { allowed.push({ ...hit, reason: a.reason }); return; }
  hits.push(hit);
}
for (const f of [...proseFiles].sort()) scanFile(f, true);
for (const f of [...codeFiles].sort()) scanFile(f, false);

// ───────────────────────────── report ─────────────────────────────
const fails = hits.filter((h) => h.level === "fail");
const warns = hits.filter((h) => h.level === "warn");
const badAllow = allow.filter((x) => x.bad);
if (JSON_OUT) {
  console.log(JSON.stringify({ root: ROOT, files: proseFiles.size + codeFiles.size, fails, warns, allowed, badAllow, allowWarning }, null, 2));
} else {
  for (const h of [...fails, ...warns].sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line))
    console.log(`${h.file}:${h.line}:${h.col}: ${h.level.toUpperCase()}[${h.rule}] "${h.match}"  ${h.hint}\n    ${h.context}`);
  if (allowWarning) console.log(`note: ${allowWarning}`);
  for (const b of badAllow) console.log(`note: unreadable allow-list line: ${b.bad}`);
  const byRule = {};
  for (const h of fails) byRule[h.rule] = (byRule[h.rule] ?? 0) + 1;
  console.log(`\nwording-check: ${proseFiles.size} prose files + ${codeFiles.size} code files; ${fails.length} fail, ${warns.length} warn, ${allowed.length} allow-listed` +
    (fails.length ? ` (by rule: ${Object.entries(byRule).map(([k, v]) => `${k} ${v}`).join(", ")})` : ""));
}
process.exit(fails.length && !WARN_ONLY ? 1 : 0);
