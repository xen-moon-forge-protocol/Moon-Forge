/**
 * Live market snapshot of every XEN contract (one per EVM chain): spot price, XEN-side
 * liquidity, 24h median price at the current hour, total supply, and what burning a given USD amount
 * would really be worth after the liquidity factor. Read-only; used to check the oracle's
 * market data and to publish "burn vs sell" numbers.
 *   npm run market            (default $100)
 *   npm run market -- 1000
 */
import { CHAINS } from "./config";
import { burnTimePrice, xenMarket, xenTotalSupply } from "./pricing";
import { finalHead } from "./evm";

async function main() {
  const usd = Number(process.argv.find((a) => /^\d+(\.\d+)?$/.test(a)) ?? "100");
  const now = Math.floor(Date.now() / 1000);
  console.log(`chain        spot USD/XEN     median24h        liquidity$   $${usd} burn → real value   supply`);
  for (const c of CHAINS) {
    try {
      const m = await xenMarket(c);
      const v = await burnTimePrice(c, m, now);
      const supply = await finalHead(c).then((h) => xenTotalSupply(c, h)).catch(() => "?");
      const realValue = (usd * m.liquidityUsd) / (m.liquidityUsd + usd);
      console.log(
        `${c.name.padEnd(12)} ${m.spotUsd.toExponential(3).padEnd(16)} ${v.usd.toExponential(3).padEnd(16)} ` +
          `${Math.round(m.liquidityUsd).toString().padStart(9)}   $${realValue.toFixed(2).padStart(8)} (${((100 * realValue) / usd).toFixed(1)}%)` +
          `   ${supply === "?" ? "?" : (Number(BigInt(supply) / 10n ** 18n) / 1e12).toFixed(1) + "T"}`,
      );
    } catch (e) {
      console.log(`${c.name.padEnd(12)} unavailable: ${String(e).slice(0, 120)}`);
    }
  }
}
main();
