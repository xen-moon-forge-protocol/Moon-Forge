import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

// The Arweave mirror build (`vite build --mode mirror`, .github/workflows/mirror-arweave.yml) is served under a path its own
// manifest id decides (https://<gateway>/<manifest id>/), unknown until the upload, so it cannot be compiled in: the
// mirror build uses relative asset URLs and reads the base path at run time from the address (the 43-character id,
// or "/" under a name that maps to the manifest). The GitHub Pages build below is unchanged.
const MIRROR_BASE = "globalThis.__MF_BASE__=(location.pathname.match(/^\\/[A-Za-z0-9_-]{43}\\//)||['/'])[0];";

const mirrorBase = (): Plugin => ({
    name: 'moon-forge-mirror-base',
    transformIndexHtml: {
        order: 'pre',
        handler: (html) => html.replace('<head>', `<head>\n    <script>${MIRROR_BASE}</script>`),
    },
});

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
    const mirror = mode === 'mirror';
    return {
        plugins: mirror ? [react(), mirrorBase()] : [react()],
        base: mirror ? './' : '/Moon-Forge/', // GitHub Pages base path
        // @solana/web3.js and @coral-xyz/anchor expect a Node-like `global`
        define: {
            global: 'globalThis',
            ...(mirror ? { 'import.meta.env.BASE_URL': 'globalThis.__MF_BASE__' } : {}),
        },
        build: {
            outDir: mirror ? 'dist-mirror' : 'dist',
            sourcemap: false,
            chunkSizeWarningLimit: 2500,
        },
        server: {
            port: 3000,
            open: true,
        },
    };
});
