/**
 * r9 fix-up (b), no network: the missing-file trap (src/recover-v3.ts). The build refuses a missing or different
 * previous file; recover-epoch restores only a copy whose data hash is the one the program recorded.
 *   npx ts-node test/recover.test.ts
 */
import assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Keypair, PublicKey } from "@solana/web3.js";
import { dataHashV3 } from "../src/rewards";
import { programId } from "../src/x1";
import {
  candidateFromPagesV3, candidatesFromGitV3, candidatesFromPathV3, candidateVerdictV3, epochDataHashOfAccountV3, prevMismatchV3, recomputedDataHashV3, recoverEpochCli, RecoverIoV3,
} from "../src/recover-v3";

let passed = 0;
let failed = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    failed++;
    console.error(`FAIL ${name}\n  ${(e as Error).stack ?? String(e)}`);
  }
}

/** a minimal v3 file: its data hash is the rewards.ts rule over everything but dataHash, proofs and publish */
function v3File(epoch: number, salt: string, publish?: { tx: string }) {
  const body = { version: 3, programId: programId.toBase58(), epoch, salt, chains: [], burns: [], leaves: [] } as Record<string, unknown>;
  const f = { ...body, dataHash: dataHashV3(body as never), proofs: {} } as Record<string, unknown>;
  if (publish) f.publish = publish;
  return f;
}
/** the raw Epoch account: disc 8 | id 8 | root 32 | data_hash 32 | … */
function epochAccount(hash: string, owner = programId) {
  const data = Buffer.alloc(200);
  Buffer.from(hash, "hex").copy(data, 48);
  return { owner, data };
}

async function main() {
  await test("the program's data hash is read from the raw Epoch account; anything else is no answer", () => {
    const h = "ab".repeat(32);
    assert.strictEqual(epochDataHashOfAccountV3(epochAccount(h), programId), h);
    assert.strictEqual(epochDataHashOfAccountV3(epochAccount(h, Keypair.generate().publicKey), programId), null, "another owner");
    assert.strictEqual(epochDataHashOfAccountV3({ owner: programId, data: Buffer.alloc(60) }, programId), null, "too short");
    assert.strictEqual(epochDataHashOfAccountV3(null, programId), null);
  });

  await test("npm run epoch refuses a missing, different or unchecked previous file (never builds on it)", () => {
    const f = v3File(7, "honest", { tx: "t7" });
    const h = f.dataHash as string;
    assert.strictEqual(recomputedDataHashV3(f), h);
    assert.strictEqual(prevMismatchV3(f as never, 7, h), null, "the file the program recorded: build on it");
    assert.match(String(prevMismatchV3(null, 7, h)), /epoch-7\.json is missing locally: restore the published file: npm run recover-epoch -- 7/);
    assert.match(String(prevMismatchV3(f as never, 7, null)), /Epoch\(7\) could not be read/);
    const other = v3File(7, "lost the race");
    assert.match(String(prevMismatchV3(other as never, 7, h)), /is not the file the program recorded for epoch 7 .*would treat other burns as paid/);
    assert.match(String(prevMismatchV3({ ...f, salt: "edited" } as never, 7, h)), /does not match its own data hash/);
  });

  await test("a candidate counts only when it is epoch n, matches its own data hash and the program's", () => {
    const f = v3File(9, "x");
    const h = f.dataHash as string;
    assert.strictEqual(candidateVerdictV3({ origin: "a", text: JSON.stringify(f) }, 9, h).ok, true);
    assert.match(candidateVerdictV3({ origin: "a", text: "{" }, 9, h).reason, /not JSON/);
    assert.match(candidateVerdictV3({ origin: "a", text: JSON.stringify(f) }, 8, h).reason, /not epoch 8/);
    assert.match(candidateVerdictV3({ origin: "a", text: JSON.stringify({ ...f, salt: "y" }) }, 9, h).reason, /its own data hash/);
    assert.match(candidateVerdictV3({ origin: "a", text: JSON.stringify(f) }, 9, "cd".repeat(32)).reason, /is not the program's/);
    assert.match(candidateVerdictV3({ origin: "a", text: JSON.stringify({ ...f, version: 9 }) }, 9, h).reason, /unknown version 9/);
  });

  await test("copies are found in files, unpacked run artifacts, the git history of every branch and the Pages copy", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mf-recover-"));
    try {
      fs.mkdirSync(path.join(dir, "artifact", "frontend", "public", "epochs"), { recursive: true });
      fs.writeFileSync(path.join(dir, "artifact", "frontend", "public", "epochs", "epoch-4.json"), "A");
      fs.writeFileSync(path.join(dir, "single.json"), "B");
      fs.mkdirSync(path.join(dir, "node_modules"));
      fs.writeFileSync(path.join(dir, "node_modules", "epoch-4.json"), "never");
      assert.deepStrictEqual(candidatesFromPathV3(path.join(dir, "artifact"), "epoch-4.json").map((c) => c.text), ["A"]);
      assert.deepStrictEqual(candidatesFromPathV3(path.join(dir, "single.json"), "epoch-4.json").map((c) => c.text), ["B"], "a file is read as given");
      assert.deepStrictEqual(candidatesFromPathV3(dir, "epoch-4.json").map((c) => c.text), ["A"], "node_modules is never read");
      assert.deepStrictEqual(candidatesFromPathV3(path.join(dir, "nope"), "epoch-4.json"), []);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    const calls: string[][] = [];
    const run = (args: string[]) => {
      calls.push(args);
      if (args[0] === "rev-parse") return "/repo\n";
      if (args[0] === "log") return "aaaa1111\nbbbb2222\n";
      if (args[1] === "aaaa1111:frontend/public/epochs/epoch-4.json") throw new Error("deleted there");
      return "OLD";
    };
    const g = candidatesFromGitV3("/repo/frontend/public/epochs/epoch-4.json", 50, run);
    assert.deepStrictEqual(g, [{ origin: "git bbbb2222:frontend/public/epochs/epoch-4.json", text: "OLD" }]);
    assert.deepStrictEqual(calls[1], ["log", "--all", "--max-count=50", "--format=%H", "--", "frontend/public/epochs/epoch-4.json"], "every branch");
    assert.deepStrictEqual(candidatesFromGitV3("/x/epoch-4.json", 5, () => { throw new Error("not a repository"); }), []);
    const pages = await candidateFromPagesV3("epoch-4.json", "https://example.invalid/epochs", (async (u: string) => ({ ok: true, text: async () => `P ${u}` })) as never);
    assert.deepStrictEqual(pages, { origin: "https://example.invalid/epochs/epoch-4.json", text: "P https://example.invalid/epochs/epoch-4.json" });
    assert.strictEqual(await candidateFromPagesV3("epoch-4.json", "https://example.invalid/", (async () => ({ ok: false })) as never), null);
  });

  await test("recover-epoch restores only the published copy (dry by default), moves a different local file aside, adds the publish record", async () => {
    const pub = v3File(12, "published"); // a copy kept before its publication: no publish record
    const h = pub.dataHash as string;
    const wrong = v3File(12, "honest build that lost the race");
    const written: { n: number; f: any }[] = [];
    const logs: string[] = [];
    let moved = 0;
    const io = (o: Partial<RecoverIoV3> = {}): RecoverIoV3 => ({
      onChain: async () => h,
      publishTx: async () => "tx12",
      local: () => wrong,
      candidates: async () => [{ origin: "git c1", text: JSON.stringify(wrong) }, { origin: "pages", text: JSON.stringify(pub) }],
      write: (n, f) => void written.push({ n, f }),
      moveAside: () => (moved++, "/tmp/epoch-12.not-published.json"),
      log: (s) => logs.push(s),
      ...o,
    });
    assert.strictEqual(await recoverEpochCli(12, [], false, io()), false, "dry");
    assert.deepStrictEqual(written, []);
    assert.strictEqual(moved, 0);
    assert(logs.some((l) => /pages: MATCH/.test(l)) && logs.some((l) => /git c1: no \(data hash .* is not the program's/.test(l)), logs.join(" | "));
    assert.strictEqual(await recoverEpochCli(12, [], true, io()), true);
    assert.strictEqual(moved, 1, "the local file that is not the published one is kept aside, never deleted");
    assert.strictEqual(written.length, 1);
    const restored = (written as { n: number; f: any }[])[0].f; // (deepStrictEqual above narrowed the array's type)
    assert.strictEqual(restored.dataHash, h);
    assert.deepStrictEqual(restored.publish, { tx: "tx12" }, "the publish transaction, found on chain");
    assert.strictEqual(dataHashV3(restored), h, "the restored file is byte for byte what the chain committed to");
    // nothing matching: nothing written, the procedure is printed, exit code 1
    const none: string[] = [];
    assert.strictEqual(await recoverEpochCli(12, ["/somewhere"], true, io({ candidates: async () => [{ origin: "git c1", text: JSON.stringify(wrong) }], log: (s) => none.push(s) })), false);
    assert(none.some((l) => /no copy of epoch-12\.json carries the data hash the program recorded/.test(l)) && none.some((l) => /OPERATORS\.md "epoch file missing"/.test(l)));
    // already in place; no Epoch on chain
    assert.strictEqual(await recoverEpochCli(12, [], true, io({ local: () => ({ ...pub, publish: { tx: "tx12" } }) })), true);
    await assert.rejects(recoverEpochCli(12, [], true, io({ onChain: async () => null })), /does not exist on chain or could not be read/);
    await assert.rejects(recoverEpochCli(0, [], true, io()), /usage/);
    void PublicKey;
  });

  console.log(`recover tests: ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
