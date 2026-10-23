// node --test: Be the House guard math (H2 withdrawal/deposit griefing). Pure functions, no RPC.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { houseDepositGuard, houseWithdrawGuard, HOUSE_DEAD_SHARES, MAX_SLIPPAGE_BPS, XNT } from '../../moonforge.mjs';

const X = BigInt(XNT);

test('withdraw: no pending bets -> minLamports = 99% of the quote, never 0, no refusal', () => {
  const g = houseWithdrawGuard({ shares: 1_000n * X, unreserved: 10_000n * X, reserved: 0n, totalShares: 10_000n * X });
  assert.equal(g.quoteUnreserved, 1_000n * X);
  assert.equal(g.quoteConservative, 1_000n * X);
  assert.equal(g.minLamports, 990n * X);
  assert.equal(g.haircutBps, 0);
  assert.equal(g.refuse, null);
});

test('withdraw: the H2 scenario (bankroll 10,000, victim 10%, 2,003.9 reserved) is refused by default', () => {
  const g = houseWithdrawGuard({ shares: 1_000n * X, unreserved: 10_000n * X, reserved: 2_003_900_000_000n, totalShares: 10_000n * X });
  assert.equal(g.quoteConservative, 799_610_000_000n); // 799.61 XNT instead of 1,000
  assert.equal(g.haircutBps, 2003);
  assert.match(g.refuse, /pending bets reserve 20\.03%/);
  assert.match(g.refuse, /799\.6100 instead of 1000\.0000 XNT/);
  // the on-chain minimum still protects: 990 XNT demanded, 799.61 paid -> SlippageExceeded
  assert.equal(g.minLamports, 990n * X);
  assert.ok(g.minLamports > g.quoteConservative);
});

test('withdraw: exactly 1% reserved passes, 1.01% is refused', () => {
  const ok = houseWithdrawGuard({ shares: 10n * X, unreserved: 10_000n * X, reserved: 100n * X, totalShares: 10_000n * X });
  assert.equal(ok.haircutBps, 100);
  assert.equal(ok.refuse, null);
  const no = houseWithdrawGuard({ shares: 10n * X, unreserved: 10_000n * X, reserved: 101n * X, totalShares: 10_000n * X });
  assert.equal(no.haircutBps, 101);
  assert.match(no.refuse, /1\.01%/);
});

test('withdraw: force skips the kit refusal but keeps the on-chain minimum; an explicit minimum is honoured', () => {
  const base = { shares: 1_000n * X, unreserved: 10_000n * X, reserved: 2_000n * X, totalShares: 10_000n * X };
  const forced = houseWithdrawGuard({ ...base, force: true });
  assert.equal(forced.refuse, null);
  assert.equal(forced.minLamports, 990n * X); // still fails on-chain at 800 paid: force alone never lowers the bar
  const accepted = houseWithdrawGuard({ ...base, force: true, minLamports: 790n * X });
  assert.equal(accepted.minLamports, 790n * X);
  assert.ok(accepted.minLamports <= accepted.quoteConservative);
});

test('withdraw: minLamports 0 (or below) is refused, by default and with force', () => {
  const base = { shares: 1n * X, unreserved: 100n * X, reserved: 0n, totalShares: 100n * X };
  assert.match(houseWithdrawGuard({ ...base, minLamports: 0n }).refuse, /minLamports 0 disables/);
  const forced = houseWithdrawGuard({ ...base, minLamports: 0n, force: true });
  assert.match(forced.refuse, /refused even with force/);
  assert.match(houseWithdrawGuard({ ...base, minLamports: -1n, force: true }).refuse, /minLamports 0 disables/);
  const one = houseWithdrawGuard({ ...base, minLamports: 1n, force: true });
  assert.equal(one.refuse, null, 'any minimum above 0 is accepted with force');
  assert.equal(one.minLamports, 1n);
});

test('withdraw: slippageBps is bounded to 0..5000; outside it (or not a whole number) is refused, even with force', () => {
  const base = { shares: 1_000n * X, unreserved: 10_000n * X, reserved: 0n, totalShares: 10_000n * X };
  assert.equal(MAX_SLIPPAGE_BPS, 5_000);
  for (const bad of [10_000, 5_001, -1, 1.5, NaN, '100']) {
    const g = houseWithdrawGuard({ ...base, slippageBps: bad, force: true });
    assert.match(g.refuse, /slippageBps must be a whole number from 0 to 5000/, `slippageBps ${bad}`);
  }
  assert.equal(houseWithdrawGuard({ ...base, slippageBps: 5_000 }).minLamports, 500n * X);
  assert.equal(houseWithdrawGuard({ ...base, slippageBps: 0 }).minLamports, 1_000n * X);
  // an explicit minimum does not use slippageBps at all
  assert.equal(houseWithdrawGuard({ ...base, slippageBps: 10_000, minLamports: 300n * X }).refuse, null);
});

test('withdraw: empty bankroll / no shares quote 0 and are refused (0 minimum)', () => {
  const g = houseWithdrawGuard({ shares: 5n, unreserved: 0n, reserved: 0n, totalShares: 0n });
  assert.equal(g.quoteUnreserved, 0n);
  assert.equal(g.minLamports, 0n);
  assert.match(g.refuse, /minLamports 0/);
});

test('deposit: first deposit mints 1 share per lamport at the dead-share value', () => {
  const g = houseDepositGuard({ amount: 20n * X, unreserved: 0n, reserved: 0n, totalShares: 0n });
  assert.equal(g.minted, 20n * X);
  assert.equal(g.fair, 20n * X);
  assert.equal(g.minShares, (20n * X * 99n) / 100n);
  assert.equal(g.refuse, null);
  assert.equal(HOUSE_DEAD_SHARES, 1_000_000n);
});

test('deposit: no pending bets -> minShares = 99% of the minted amount (same as the program quote)', () => {
  const g = houseDepositGuard({ amount: 2n * X, unreserved: 22n * X, reserved: 0n, totalShares: 22n * X });
  assert.equal(g.minted, 2n * X);
  assert.equal(g.minShares, (2n * X * 99n) / 100n);
  assert.equal(g.refuse, null);
});

test('deposit: the H2 mirror (reserved 23.5%) is refused and min_shares from the conservative value makes the tx fail', () => {
  const unreserved = 10_000n * X, reserved = 2_350n * X, total = 10_000n * X;
  const g = houseDepositGuard({ amount: 1_000n * X, unreserved, reserved, totalShares: total });
  assert.equal(g.haircutBps, 2350);
  assert.match(g.refuse, /23\.50%/);
  assert.equal(g.minted, 1_000n * X); // what the program would mint (optimistic)
  assert.ok(g.fair > g.minted); // 1,307 shares if every pending bet wins
  assert.ok(g.minShares > g.minted, 'the program would refuse: minted < min_shares');
});

test('deposit: 2% reserved -> min_shares above the minted amount (tx fails), 1% -> passes', () => {
  const two = houseDepositGuard({ amount: 100n * X, unreserved: 10_000n * X, reserved: 200n * X, totalShares: 10_000n * X });
  assert.ok(two.minShares > two.minted);
  assert.ok(two.refuse);
  const one = houseDepositGuard({ amount: 100n * X, unreserved: 10_000n * X, reserved: 100n * X, totalShares: 10_000n * X });
  assert.ok(one.minShares <= one.minted, 'exactly 1% is within the 1% slippage');
  assert.equal(one.refuse, null);
});

test('deposit: slippageBps 10000 (min_shares 0) and any value outside 0..5000 are refused, even with force', () => {
  const base = { amount: 100n * X, unreserved: 10_000n * X, reserved: 50n * X, totalShares: 10_000n * X };
  for (const force of [false, true]) {
    for (const bad of [10_000, 5_001, -1, 2.5]) {
      const g = houseDepositGuard({ ...base, slippageBps: bad, force });
      assert.match(g.refuse, /slippageBps must be a whole number from 0 to 5000/, `slippageBps ${bad} force ${force}`);
      assert.equal(g.minShares, 0n);
    }
  }
  const widest = houseDepositGuard({ ...base, slippageBps: 5_000 });
  assert.equal(widest.refuse, null);
  assert.ok(widest.minShares > 0n);
});

test('deposit: an amount too small to mint a share demands min_shares 0 and is refused', () => {
  const g = houseDepositGuard({ amount: 1n, unreserved: 10_000n * X, reserved: 0n, totalShares: 10n * X, force: true });
  assert.equal(g.minShares, 0n);
  assert.match(g.refuse, /min_shares would be 0/);
});

test('deposit: force falls back to the plain slippage guard on the minted amount, never 0', () => {
  const g = houseDepositGuard({ amount: 100n * X, unreserved: 10_000n * X, reserved: 2_000n * X, totalShares: 10_000n * X, force: true });
  assert.equal(g.refuse, null);
  assert.equal(g.minShares, (g.minted * 99n) / 100n);
  assert.ok(g.minShares > 0n);
});

test('both guards accept numbers and strings as well as bigints', () => {
  const g = houseWithdrawGuard({ shares: '1000000000', unreserved: 100000000000, reserved: '0', totalShares: 100000000000 });
  assert.equal(g.minLamports, 990_000_000n);
  const d = houseDepositGuard({ amount: 1000000000, unreserved: '0', reserved: 0, totalShares: 0 });
  assert.equal(d.minted, 1_000_000_000n);
});
