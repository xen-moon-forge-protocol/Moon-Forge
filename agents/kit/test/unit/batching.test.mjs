// node --test: myArtifacts() with 101+ records calls getMultipleAccountsInfo in slices of at most 100 (the RPC limit)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Keypair, PublicKey } from '@solana/web3.js';
import { MoonForge, MPL_CORE, PDA, coreOwner } from '../../moonforge.mjs';

/** A Metaplex Core AssetV1 account owned by `owner` inside the Moon Forge collection (the bytes the kit reads). */
function coreAsset(owner, collection = PDA.collection()) {
  const d = Buffer.alloc(120);
  d[0] = 1; // Key::AssetV1
  owner.toBuffer().copy(d, 1);
  d[33] = 2; // UpdateAuthority::Collection
  collection.toBuffer().copy(d, 34);
  return { owner: MPL_CORE, data: d, lamports: 1, executable: false };
}

function fakeKit({ records, me, onBatch }) {
  const program = {
    provider: { connection: {
      rpcEndpoint: 'stub',
      async getMultipleAccountsInfo(keys) {
        onBatch(keys.length);
        return keys.map((k) => records.find((r) => r.account.asset.equals(k)).info);
      },
    } },
    account: { artifactRecord: { async all() { return records; } } },
    idl: null,
  };
  return new MoonForge(program, me, { onWarning: () => {} });
}

test('101 records: two batches (100 + 1), every record owned by me is returned in order', async () => {
  const me = Keypair.generate();
  const records = Array.from({ length: 101 }, (_, i) => {
    const asset = Keypair.generate().publicKey;
    return { account: { asset, tier: i % 4, backing: 5_000_000_000 - i, origin: 0 }, info: coreAsset(me.publicKey) };
  });
  const batches = [];
  const kit = fakeKit({ records, me, onBatch: (n) => batches.push(n) });
  const mine = await kit.myArtifacts();
  assert.deepEqual(batches, [100, 1]);
  assert.equal(mine.length, 101);
  assert.ok(mine.every((a, i) => a.asset.equals(records[i].account.asset)));
  assert.equal(mine[0].backingXnt, 5);
});

test('250 records mixed owners: slices of 100, 100, 50; only live assets of this wallet in the collection are kept', async () => {
  const me = Keypair.generate(), other = Keypair.generate();
  const records = Array.from({ length: 250 }, (_, i) => {
    const asset = Keypair.generate().publicKey;
    let info;
    if (i % 5 === 0) info = coreAsset(other.publicKey); // someone else's
    else if (i % 5 === 1) info = null; // burned (no account)
    else if (i % 5 === 2) info = coreAsset(me.publicKey, Keypair.generate().publicKey); // right owner, wrong collection
    else if (i % 5 === 3) info = { ...coreAsset(me.publicKey), owner: new PublicKey('11111111111111111111111111111111') }; // not a Core account
    else info = coreAsset(me.publicKey);
    return { account: { asset, tier: 0, backing: 0, origin: 0 }, info };
  });
  const batches = [];
  const kit = fakeKit({ records, me, onBatch: (n) => batches.push(n) });
  const mine = await kit.myArtifacts();
  assert.deepEqual(batches, [100, 100, 50]);
  assert.equal(mine.length, 50);
  assert.ok(batches.every((n) => n <= 100));
});

test('no records: no RPC call', async () => {
  const batches = [];
  const kit = fakeKit({ records: [], me: Keypair.generate(), onBatch: (n) => batches.push(n) });
  assert.deepEqual(await kit.myArtifacts(), []);
  assert.deepEqual(batches, []);
});

test('coreOwner rejects short data, foreign owners and other update-authority kinds', () => {
  const me = Keypair.generate().publicKey;
  assert.equal(coreOwner(null), null);
  assert.equal(coreOwner({ owner: MPL_CORE, data: Buffer.alloc(10) }), null);
  const a = coreAsset(me);
  assert.ok(coreOwner(a).equals(me));
  a.data[33] = 1; // UpdateAuthority::Address
  assert.equal(coreOwner(a), null);
});
