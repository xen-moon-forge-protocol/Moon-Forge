# Moon Forge - NFT IPFS Upload Guide

## Overview
This guide explains how to upload your NFT images and metadata to IPFS for permanent, decentralized storage.

## Step 1: Prepare Your Images

You need 4 base images (one per tier):
- `lunar_dust.png` - Common artifact
- `cosmic_shard.png` - Rare artifact
- `solar_core.png` - Epic artifact
- `void_anomaly.png` - Legendary artifact

**Recommended specs:**
- Format: PNG or WEBP
- Size: 1000x1000 pixels
- File size: < 5MB each

## Step 2: Upload Images to IPFS

### Option A: Pinata (Recommended)

1. Create account at https://pinata.cloud
2. Go to "Files" → "Upload" → "Folder"
3. Upload folder containing your 4 images
4. Copy the CID (starts with `Qm...` or `bafy...`)
5. Your images will be at: `ipfs://YOUR_CID/lunar_dust.png`

### Option B: NFT.Storage (Free)

1. Create account at https://nft.storage
2. Click "Upload"
3. Upload folder with 4 images
4. Copy the CID

## Step 3: Generate Metadata

1. Open `scripts/nft-metadata/generate-metadata.ts`
2. Update `IPFS_IMAGE_BASE` with your images CID:
   ```typescript
   const IPFS_IMAGE_BASE = "ipfs://Qm123abc.../";
   ```
3. Run the generator:
   ```bash
   cd scripts/nft-metadata
   npx ts-node generate-metadata.ts
   ```
4. Check the `output/` folder - should have 1000 JSON files

## Step 4: Upload Metadata to IPFS

1. Upload the entire `output/` folder to Pinata/NFT.Storage
2. Copy the metadata folder CID
3. Your metadata will be at: `ipfs://METADATA_CID/1.json`

## Step 5: Configure Contract

After deploying `MoonArtifacts.sol`:

```javascript
// In your deploy script or manually via Etherscan
const artifactsContract = await ethers.getContractAt("MoonArtifacts", CONTRACT_ADDRESS);
await artifactsContract.setBaseURI("ipfs://YOUR_METADATA_CID/");
```

## Verification

Test that everything works:
1. Call `tokenURI(1)` on your contract
2. Should return: `ipfs://YOUR_METADATA_CID/1.json`
3. Access that URL via IPFS gateway: `https://ipfs.io/ipfs/YOUR_METADATA_CID/1.json`
4. Verify the JSON has correct image URL

## IPFS Gateways

To view IPFS content in browser:
- https://ipfs.io/ipfs/YOUR_CID/
- https://gateway.pinata.cloud/ipfs/YOUR_CID/
- https://cloudflare-ipfs.com/ipfs/YOUR_CID/

## Notes

- IPFS content is permanent once pinned
- Use a pinning service (Pinata, NFT.Storage) to ensure availability
- Never change the metadata after minting NFTs
- CID changes if ANY file content changes
