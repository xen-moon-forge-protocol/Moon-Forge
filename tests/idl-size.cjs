#!/usr/bin/env node
// IDL budget check (SPEC-UPGRADE-v2 5, OD-29). anchor-cli stores the IDL as zlib-compressed COMPACT JSON, so this
// measures zlib level 6 of JSON.stringify (no indentation), never of the pretty-printed file and never level 9.
// Usage: node tests/idl-size.cjs <idl.json> [--strict]   (build it with `anchor idl build --no-docs`)
// Prints the size as-is and with every `docs` entry stripped; --strict exits 1 when the measured IDL (as built)
// exceeds the 16,214-B IDL account (the resize path of 8.5 still exists while the IDL authority does).
const fs = require("fs");
const zlib = require("zlib");
const BUDGET = 16_214;
const [file, flag] = process.argv.slice(2);
if (!file) { console.error("usage: node tests/idl-size.cjs <idl.json> [--strict]"); process.exit(2); }
const idl = JSON.parse(fs.readFileSync(file, "utf8"));
const strip = (o) => Array.isArray(o) ? o.map(strip)
  : o && typeof o === "object" ? Object.fromEntries(Object.entries(o).filter(([k]) => k !== "docs").map(([k, v]) => [k, strip(v)]))
  : o;
const size = (o) => { const s = JSON.stringify(o); return [s.length, zlib.deflateSync(Buffer.from(s), { level: 6 }).length]; };
let docs = 0;
JSON.stringify(idl, (k, v) => { if (k === "docs") docs++; return v; });
const [rawAs, zAs] = size(idl);
const [rawNo, zNo] = size(strip(idl));
console.log(`instructions ${idl.instructions.length}, accounts ${(idl.accounts || []).length}, events ${(idl.events || []).length}, errors ${(idl.errors || []).length}, types ${(idl.types || []).length}, docs entries ${docs}`);
console.log(`as built : raw ${rawAs} B, zlib-6 ${zAs} B`);
console.log(`no docs  : raw ${rawNo} B, zlib-6 ${zNo} B`);
console.log(`budget   : ${BUDGET} B -> ${zAs <= BUDGET ? "fits" : "OVER"} (as built)`);
if (docs > 0) console.log("note: docs present; the on-chain IDL is built with `anchor idl build --no-docs`");
if (flag === "--strict" && zAs > BUDGET) process.exit(1);
