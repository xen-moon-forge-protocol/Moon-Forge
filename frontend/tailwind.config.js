/** @type {import('tailwindcss').Config} */
export default {
    content: [
        "./index.html",
        "./src/**/*.{js,ts,jsx,tsx}",
    ],
    theme: {
        extend: {
            colors: {
                // Moon Forge Dark Space Theme
                'space': {
                    900: '#0a0a0f',
                    800: '#12121a',
                    700: '#1a1a25',
                    600: '#252533',
                },
                'lunar': {
                    100: '#f0f0f5',
                    200: '#d8d8e0',
                    300: '#a0a0b0',
                    400: '#7070a0',
                    500: '#5050a0',
                },
                'forge': {
                    orange: '#ff6b35',
                    gold: '#ffd700',
                    ember: '#ff4500',
                },
                'mission': {
                    launchpad: '#00d4ff',
                    orbit: '#a855f7',
                    moon: '#ffd700',
                }
            },
            fontFamily: {
                'space': ['Orbitron', 'sans-serif'],
                'mono': ['JetBrains Mono', 'monospace'],
            },
            animation: {
                'pulse-slow': 'pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite',
                'float': 'float 6s ease-in-out infinite',
                'glow': 'glow 2s ease-in-out infinite alternate',
            },
            keyframes: {
                float: {
                    '0%, 100%': { transform: 'translateY(0)' },
                    '50%': { transform: 'translateY(-10px)' },
                },
                glow: {
                    '0%': { boxShadow: '0 0 5px #ff6b35, 0 0 10px #ff6b35, 0 0 15px #ff6b35' },
                    '100%': { boxShadow: '0 0 10px #ffd700, 0 0 20px #ffd700, 0 0 30px #ffd700' },
                }
            },
            backgroundImage: {
                'space-gradient': 'radial-gradient(ellipse at center, #1a1a25 0%, #0a0a0f 100%)',
                'forge-gradient': 'linear-gradient(135deg, #ff6b35 0%, #ffd700 100%)',
            }
        },
    },
    plugins: [],
}
