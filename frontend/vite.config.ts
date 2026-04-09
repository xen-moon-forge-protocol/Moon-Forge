import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vitejs.dev/config/
export default defineConfig({
    plugins: [react()],
    base: '/Moon-Forge/', // GitHub Pages base path
    build: {
        outDir: 'dist',
        sourcemap: false,
    },
    server: {
        port: 3000,
        open: true,
    },
});
