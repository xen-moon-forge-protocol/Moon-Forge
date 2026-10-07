import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vitejs.dev/config/
export default defineConfig({
    plugins: [react()],
    base: '/Moon-Forge/', // GitHub Pages base path
    // @solana/web3.js and @coral-xyz/anchor expect a Node-like `global`
    define: { global: 'globalThis' },
    build: {
        outDir: 'dist',
        sourcemap: false,
        chunkSizeWarningLimit: 2500,
    },
    server: {
        port: 3000,
        open: true,
    },
});
