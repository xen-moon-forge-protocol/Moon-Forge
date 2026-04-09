# X1 SVM Deployment Guide

## Prerequisites
To deploy these programs to X1 (SVM), you need the Solana tool suite and Anchor:
1. **Rust:** `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`
2. **Solana CLI:** `sh -c "$(curl -sSfL https://release.solana.com/stable/install)"`
3. **Anchor:** `cargo install --git https://github.com/coral-xyz/anchor anchor-cli --locked`

## Setup
1. Point to X1 RPC:
   `solana config set --url https://rpc.mainnet.x1.xyz`
2. Create/Import Deployer Key:
   `solana-keygen new`

## Deployment
1. Go to `programs/moon-forge-games`.
2. Build: `anchor build`
3. Deploy: `anchor deploy`
