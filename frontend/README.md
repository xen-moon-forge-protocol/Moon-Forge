# Moon Forge Frontend

React + Vite frontend for the Moon Forge Protocol.

## Quick Start

```bash
# Install dependencies
npm install

# Start development server
npm run dev

# Build for production
npm run build

# Deploy to GitHub Pages
npm run deploy
```

## Stack

- **React 18** - UI framework
- **Vite** - Build tool
- **TypeScript** - Type safety
- **Tailwind CSS** - Styling (Dark Space Theme)
- **ethers.js v6** - Blockchain interaction
- **React Router** - Navigation

## Pages

| Route | Component | Description |
|-------|-----------|-------------|
| `/` | Home | Landing page with stats and tier previews |
| `/forge` | TheForge | XEN burn interface |
| `/missions` | MissionControl | Vesting dashboard and claim |
| `/nft` | MoonMarket | Commander NFT minting |

## Features

- ✅ Dual wallet support (EVM + X1)
- ✅ Tier selection (Launchpad, Orbit, Moon Landing)
- ✅ Burn estimation calculator
- ✅ Vesting progress tracking
- ✅ System status transparency dashboard
- ✅ Referral tracking via URL params

## Configuration

Update contract addresses in `src/lib/constants.ts` after deployment.

## Deployment

The app is configured for GitHub Pages deployment:

```bash
npm run deploy
```

This builds the app and pushes to the `gh-pages` branch.

## Anonymous Hosting

For maximum anonymity:
1. Create a fresh GitHub account (use ProtonMail)
2. Use Tor/VPN when committing
3. Never link to personal accounts
