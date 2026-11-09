// The signing key adapter of evm-guard.mjs, on ethers v6 (the bot's only dependency, loaded only when an EVM key is
// used: live burns, or reading the wallet's address). The key stays inside the ethers Wallet; nothing here prints it.

async function loadEthers() {
  try { return await import('ethers'); } catch {
    throw new Error('ethers is not installed: run `npm ci --ignore-scripts` in bots/moon-forge-bot (needed to sign live burns)');
  }
}

/** { address, sign(req) → signed hex, hashOf(signed) → tx hash } from a 0x-hex private key. */
export async function ethersKey(privateKeyHex) {
  const { Wallet, Transaction } = await loadEthers();
  const w = new Wallet(privateKeyHex);
  return {
    address: w.address,
    sign: (req) => { const { from: _from, ...rest } = req; return w.signTransaction(rest); },
    hashOf: (signed) => Transaction.from(signed).hash,
  };
}
