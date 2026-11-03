/**
 * Vitest config of the localnet smoke ONLY (test/localnet/smoke.localnet.ts). The normal `npx vitest run` never picks the
 * smoke up (its name does not match the default *.test.* pattern), and the smoke itself is skipped without MF_LOCALNET_RPC.
 *   MF_LOCALNET_RPC=http://127.0.0.1:8899 npm run test:localnet
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
    define: { global: 'globalThis' },
    test: {
        include: ['test/localnet/**/*.localnet.ts'],
        testTimeout: 300_000,
        hookTimeout: 120_000,
        fileParallelism: false,
    },
});
