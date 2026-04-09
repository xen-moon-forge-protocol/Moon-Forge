// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Strings.sol";

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *                           MOON ARTIFACTS v7.1
 *                    THE COMMUNITY GOVERNANCE UPDATE
 * ═══════════════════════════════════════════════════════════════════════════
 * 
 * 🔒 CORE MECHANICS (v6.0 + v7.1):
 * - Lock/Release: NFT Locked on Mission, Released on Exit
 * - Weekly Pulse: +5% Price, -5% Decay (Floor at Base)
 * 
 * ⚖️ v7.1 FEE STRUCTURE (100%):
 * - 95.5% Reward Pool
 * - 1.0% Oracle Gas (with SPILLOVER)
 * - 3.5% Dev/Ref (Legacy: 4.0% -> Ref 2.0%, Arch 1.5%)
 * 
 * 🌊 ORACLE SPILLOVER:
 * - Oracle Wallet CAP = 1,000 XNT
 * - If Oracle has > 1,000 XNT, the 1% fee goes to REWARD POOL instead.
 * 
 * ⏳ ARCHITECT TIME LOCK:
 * - Architect's 1.5% fee is split 50/50:
 *   - 0.75% Liquid (Immediate)
 *   - 0.75% TimeLocked (Vested 10% per month via MoonTimeLock)
 */

contract MoonArtifacts is ERC721, Ownable, ReentrancyGuard {
    
    // ═══════════════════════════════════════════════════════════════════════
    //                              CONSTANTS
    // ═══════════════════════════════════════════════════════════════════════
    
    uint256 public constant TOTAL_SUPPLY = 1000;
    
    // Pricing model: 1 XNT per 1% boost — consistent ratio across all tiers.
    // Neutral epoch: avg allocation ≈ 95 XNT/pilot. Dynamic pricing handles growth.
    // Floor = base price; enforced in contract; price can NEVER go below these values.
    uint256 public constant BASE_PRICE_LUNAR_DUST    =  5 ether; //  5 XNT (+5%  boost) → 1 XNT per 1%
    uint256 public constant BASE_PRICE_COSMIC_SHARD  = 10 ether; // 10 XNT (+10% boost) → 1 XNT per 1%
    uint256 public constant BASE_PRICE_SOLAR_CORE    = 20 ether; // 20 XNT (+20% boost) → 1 XNT per 1%
    uint256 public constant BASE_PRICE_VOID_ANOMALY  = 50 ether; // 50 XNT (+50% boost) → 1 XNT per 1%
    
    // Price dynamics
    uint256 public constant PRICE_STEP_BPS = 500;       // +5%
    uint256 public constant DECAY_PERIOD = 7 days;
    uint256 public constant DECAY_DIVISOR = 10500;      // /1.05
    uint256 public constant BPS_BASE = 10000;
    
    // Fee splits v7.1 (MUST SUM TO 10000)
    uint256 public constant POOL_SHARE_BPS = 9550;     // 95.5%
    uint256 public constant ORACLE_GAS_BPS = 100;      // 1.0%
    uint256 public constant REF_SHARE_BPS = 200;       // 2.0%
    uint256 public constant ARCH_SHARE_BPS = 150;      // 1.5%
    // Note: If no referrer, Arch gets full 3.5% (split 50/50 liquid/lock)
    uint256 public constant NO_REF_ARCH_SHARE_BPS = 350;

    // Oracle Cap
    uint256 public constant ORACLE_CAP = 1000 ether;

    // ═══════════════════════════════════════════════════════════════════════
    //                              TYPES
    // ═══════════════════════════════════════════════════════════════════════
    
    enum ArtifactTier { LUNAR_DUST, COSMIC_SHARD, SOLAR_CORE, VOID_ANOMALY }
    
    struct ArtifactData {
        ArtifactTier tier;
        uint256 boostBps;
        bool equipped;
        uint8 variantId; // Visual variant (0-2)
    }
    
    struct PriceData {
        uint256 lastPrice;
        uint256 lastSoldTime;
    }
    
    // ═══════════════════════════════════════════════════════════════════════
    //                              STATE
    // ═══════════════════════════════════════════════════════════════════════
    
    // NOTE: Owner must call renounceOwnership() after all setup is complete.
    address public immutable architectWallet;
    address public vaultContract;
    address public immutable oracleWallet;
    address public timeLockContract; // v7.1
    bool public initialized;
    
    mapping(uint256 => ArtifactData) public artifacts;
    mapping(uint256 => PriceData) public priceHistory;
    mapping(uint256 => uint256) public usageCount;
    mapping(address => uint256) public equippedArtifact;
    
    // Pool arrays
    uint256[] private poolLunarDust;
    uint256[] private poolCosmicShard;
    uint256[] private poolSolarCore;
    uint256[] private poolVoidAnomaly;
    
    // Locked NFTs
    mapping(uint256 => bool) public isLocked;
    uint256 public totalLocked;
    
    uint256 public totalSales;
    uint256 public totalRecycled;
    uint256 public totalVolume;
    
    // NFT Metadata
    string private _baseTokenURI;
    
    // ═══════════════════════════════════════════════════════════════════════
    //                              EVENTS
    // ═══════════════════════════════════════════════════════════════════════
    
    event PoolInitialized(uint256 timestamp);
    event ArtifactPurchased(address indexed buyer, uint256 indexed tokenId, uint256 price, address referrer);
    event ArtifactLocked(address indexed user, uint256 indexed tokenId);
    event ArtifactRestocked(uint256 indexed tokenId, uint256 usageCount);
    event OracleSpillover(uint256 amount);
    
    // ═══════════════════════════════════════════════════════════════════════
    //                              CONSTRUCTOR
    // ═══════════════════════════════════════════════════════════════════════
    
    constructor(
        address _architectWallet, 
        address _vaultContract,
        address _oracleWallet
    ) ERC721("Moon Artifacts", "ARTIFACT") Ownable() {
        require(_architectWallet != address(0), "Invalid architect");
        architectWallet = _architectWallet;
        vaultContract = _vaultContract;
        oracleWallet = _oracleWallet;
    }
    
    // ═══════════════════════════════════════════════════════════════════════
    //                              ADMIN
    // ═══════════════════════════════════════════════════════════════════════

    function initializePool() external onlyOwner {
        require(!initialized, "Already initialized");
        initialized = true;
        
        uint256 tokenId = 1;
        // Minting logic (simplified for brevity in this snippet, assumes same logic as v6)
        // 600 Dust, 300 Shard, 90 Core, 10 Void
        for (uint256 i = 0; i < 600; i++) _mintToPool(tokenId++, ArtifactTier.LUNAR_DUST);
        for (uint256 i = 0; i < 300; i++) _mintToPool(tokenId++, ArtifactTier.COSMIC_SHARD);
        for (uint256 i = 0; i < 90; i++) _mintToPool(tokenId++, ArtifactTier.SOLAR_CORE);
        for (uint256 i = 0; i < 10; i++) _mintToPool(tokenId++, ArtifactTier.VOID_ANOMALY);
        
        emit PoolInitialized(block.timestamp);
    }
    
    function _mintToPool(uint256 tokenId, ArtifactTier tier) internal {
        _mint(address(this), tokenId);
        uint256 boost = 0;
        if (tier == ArtifactTier.LUNAR_DUST) boost = 500;
        else if (tier == ArtifactTier.COSMIC_SHARD) boost = 1000;
        else if (tier == ArtifactTier.SOLAR_CORE) boost = 2000;
        else boost = 5000;
        
        // Cycle variants 0, 1, 2 based on tokenId
        uint8 variantId = uint8(tokenId % 3);
        artifacts[tokenId] = ArtifactData(tier, boost, false, variantId);
        uint256 basePrice = _getBasePrice(tier);
        priceHistory[tokenId] = PriceData(basePrice, block.timestamp);
        _addToPool(tokenId, tier);
    }
    
    /// @notice One-time set — vault is locked after pool is initialized.
    ///         Guarantees NFT revenues always flow to the official Moon Forge pool.
    function setVaultContract(address _vault) external onlyOwner {
        require(!initialized, "Vault locked after pool init");
        require(_vault != address(0), "Invalid vault");
        vaultContract = _vault;
    }
    /// @notice One-time set — timelock address is permanent once set.
    function setTimeLockContract(address _timeLock) external onlyOwner {
        require(timeLockContract == address(0), "TimeLock already set");
        timeLockContract = _timeLock;
    }
    
    /**
     * @dev Set base URI for NFT metadata (e.g., "ipfs://Qm.../")
     * The final tokenURI will be: baseURI + tokenId + ".json"
     */
    function setBaseURI(string calldata baseURI) external onlyOwner {
        require(!initialized, "URI locked after pool initialization");
        _baseTokenURI = baseURI;
    }
    
    /**
     * @dev Returns the metadata URI for a given token
     * Format: {baseURI}{tokenId}.json
     * Example: ipfs://Qm.../42.json
     */
    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        require(_ownerOf(tokenId) != address(0), "Token does not exist");
        
        if (bytes(_baseTokenURI).length == 0) {
            return "";
        }
        
        return string(abi.encodePacked(_baseTokenURI, Strings.toString(tokenId), ".json"));
    }
    
    // ═══════════════════════════════════════════════════════════════════════
    //                              PRICING & BUY
    // ═══════════════════════════════════════════════════════════════════════
    
    function getCurrentPrice(uint256 tokenId) public view returns (uint256) {
        ArtifactTier tier = artifacts[tokenId].tier;
        if (tier == ArtifactTier.LUNAR_DUST) return BASE_PRICE_LUNAR_DUST;
        
        PriceData memory pd = priceHistory[tokenId];
        uint256 basePrice = _getBasePrice(tier);
        uint256 periodsPassed = (block.timestamp - pd.lastSoldTime) / DECAY_PERIOD;
        
        if (periodsPassed == 0) return pd.lastPrice;
        
        uint256 price = pd.lastPrice;
        for (uint256 i = 0; i < periodsPassed && i < 52; i++) {
            price = (price * BPS_BASE) / DECAY_DIVISOR;
            if (price <= basePrice) return basePrice;
        }
        return price;
    }
    
    function buyArtifact(ArtifactTier tier, address referrer) external payable nonReentrant {
        require(initialized, "Not initialized");
        require(referrer != msg.sender, "Self-ref");
        
        uint256 tokenId = _popFromPool(tier);
        require(tokenId != 0, "Sold out");
        
        uint256 price = getCurrentPrice(tokenId);
        require(msg.value >= price, "Insufficient");
        
        uint256 nextPrice = tier == ArtifactTier.LUNAR_DUST 
            ? BASE_PRICE_LUNAR_DUST 
            : price + (price * PRICE_STEP_BPS) / BPS_BASE;
            
        priceHistory[tokenId] = PriceData(nextPrice, block.timestamp);
        
        _distributeFunds(price, referrer);
        _transfer(address(this), msg.sender, tokenId);
        
        totalSales++;
        totalVolume += price;
        
        if (msg.value > price) {
            (bool okRef, ) = payable(msg.sender).call{value: msg.value - price}("");
            require(okRef, "Refund failed");
        }
        emit ArtifactPurchased(msg.sender, tokenId, price, referrer);
    }
    
    // ═══════════════════════════════════════════════════════════════════════
    //                              FUNDS (v7.1)
    // ═══════════════════════════════════════════════════════════════════════
    
    function _distributeFunds(uint256 price, address referrer) internal {
        uint256 poolShare = (price * POOL_SHARE_BPS) / BPS_BASE;
        uint256 oracleShare = (price * ORACLE_GAS_BPS) / BPS_BASE;
        
        // 1. ORACLE SPILLOVER
        // If Oracle balance > CAP, redirect that share to pool instead.
        if (oracleWallet.balance >= ORACLE_CAP) {
            poolShare += oracleShare;
            emit OracleSpillover(oracleShare);
        } else if (oracleWallet != address(0)) {
            (bool okO, ) = payable(oracleWallet).call{value: oracleShare}("");
            require(okO, "Oracle transfer failed");
        }

        // Send Pool Share to vault (pool = contract balance of MoonForgeBase)
        if (vaultContract != address(0)) {
            (bool okP, ) = payable(vaultContract).call{value: poolShare}("");
            require(okP, "Pool transfer failed");
        }

        // 2. REF / ARCH SPLIT
        uint256 refShare = 0;
        uint256 archShare = 0;

        if (referrer != address(0)) {
            refShare  = (price * REF_SHARE_BPS) / BPS_BASE;  // 2.0%
            archShare = (price * ARCH_SHARE_BPS) / BPS_BASE;  // 1.5%
            (bool okR, ) = payable(referrer).call{value: refShare}("");
            require(okR, "Referrer transfer failed");
        } else {
            archShare = (price * NO_REF_ARCH_SHARE_BPS) / BPS_BASE; // 3.5%
        }

        // 3. ARCHITECT TIME LOCK — 50% liquid, 50% vested
        if (archShare > 0) {
            uint256 lockedPart = archShare / 2;
            uint256 liquidPart = archShare - lockedPart;

            (bool okA, ) = payable(architectWallet).call{value: liquidPart}("");
            require(okA, "Architect transfer failed");

            if (timeLockContract != address(0)) {
                (bool okL, ) = payable(timeLockContract).call{value: lockedPart}("");
                require(okL, "TimeLock transfer failed");
            } else {
                // Fallback if TimeLock not deployed yet: send all liquid to avoid loss
                (bool okAf, ) = payable(architectWallet).call{value: lockedPart}("");
                require(okAf, "Architect fallback failed");
            }
        }
    }
    
    // ═══════════════════════════════════════════════════════════════════════
    //                              LOCK / RESTOCK
    // ═══════════════════════════════════════════════════════════════════════
    
    function getGameBoost(uint256 tokenId) external view returns (uint256) {
        if (!_exists(tokenId)) return 0;
        return artifacts[tokenId].boostBps;
    }

    // Duplicate getArtifactInfo removed (kept the more detailed one below)
    function lockArtifact(address user) external returns (uint256 tokenId, uint256 boostBps) {
        require(msg.sender == vaultContract, "Only vault");
        tokenId = equippedArtifact[user];
        require(tokenId != 0, "None");
        require(!isLocked[tokenId], "Locked");
        
        boostBps = artifacts[tokenId].boostBps;
        equippedArtifact[user] = 0;
        artifacts[tokenId].equipped = false;
        
        _transfer(user, vaultContract, tokenId);
        isLocked[tokenId] = true;
        totalLocked++;
        emit ArtifactLocked(user, tokenId);
    }
    
    function restockArtifact(uint256 tokenId) external {
        require(msg.sender == vaultContract, "Only vault");
        
        ArtifactTier tier = artifacts[tokenId].tier;
        isLocked[tokenId] = false;
        totalLocked--;
        usageCount[tokenId]++;
        totalRecycled++;
        
        _transfer(vaultContract, address(this), tokenId);
        _addToPool(tokenId, tier);
        
        emit ArtifactRestocked(tokenId, usageCount[tokenId]);
    }
    
    // ═══════════════════════════════════════════════════════════════════════
    //                              HELPERS
    // ═══════════════════════════════════════════════════════════════════════

    function equipArtifact(uint256 tokenId) external {
        require(ownerOf(tokenId) == msg.sender, "Not owner");
        require(!artifacts[tokenId].equipped, "Equipped");
        require(equippedArtifact[msg.sender] == 0, "Has one");
        artifacts[tokenId].equipped = true;
        equippedArtifact[msg.sender] = tokenId;
    }
    
    function unequipArtifact(uint256 tokenId) external {
        require(ownerOf(tokenId) == msg.sender, "Not owner");
        require(equippedArtifact[msg.sender] == tokenId, "Not equipped");
        artifacts[tokenId].equipped = false;
        equippedArtifact[msg.sender] = 0;
    }

    function _addToPool(uint256 tokenId, ArtifactTier tier) internal {
        if (tier == ArtifactTier.LUNAR_DUST) poolLunarDust.push(tokenId);
        else if (tier == ArtifactTier.COSMIC_SHARD) poolCosmicShard.push(tokenId);
        else if (tier == ArtifactTier.SOLAR_CORE) poolSolarCore.push(tokenId);
        else poolVoidAnomaly.push(tokenId);
    }
    
    function _popFromPool(ArtifactTier tier) internal returns (uint256) {
        uint256[] storage pool;
        if (tier == ArtifactTier.LUNAR_DUST) pool = poolLunarDust;
        else if (tier == ArtifactTier.COSMIC_SHARD) pool = poolCosmicShard;
        else if (tier == ArtifactTier.SOLAR_CORE) pool = poolSolarCore;
        else pool = poolVoidAnomaly;
        
        if (pool.length == 0) return 0;
        uint256 tokenId = pool[pool.length - 1];
        pool.pop();
        return tokenId;
    }

    function _getBasePrice(ArtifactTier tier) internal pure returns (uint256) {
        if (tier == ArtifactTier.LUNAR_DUST) return BASE_PRICE_LUNAR_DUST;
        if (tier == ArtifactTier.COSMIC_SHARD) return BASE_PRICE_COSMIC_SHARD;
        if (tier == ArtifactTier.SOLAR_CORE) return BASE_PRICE_SOLAR_CORE;
        return BASE_PRICE_VOID_ANOMALY;
    }
    
    // View functions omitted for brevity in thought, but included in file write
    function isEquipped(address user) external view returns (bool) { return equippedArtifact[user] != 0; }
    function getEquippedBonus(address user) external view returns (uint256) {
         if (equippedArtifact[user] == 0) return 0;
         return artifacts[equippedArtifact[user]].boostBps;
    }
    function getAllPoolStock() external view returns (uint256, uint256, uint256, uint256) {
        return (poolLunarDust.length, poolCosmicShard.length, poolSolarCore.length, poolVoidAnomaly.length);
    }
    function getMarketStatus() external view returns (uint256 a, uint256 l, uint256 c) {
        a = poolLunarDust.length + poolCosmicShard.length + poolSolarCore.length + poolVoidAnomaly.length;
        l = totalLocked;
        c = TOTAL_SUPPLY - a - l;
    }
     function getArtifactInfo(uint256 tokenId) external view returns (
        ArtifactTier tier, uint256 boostBps, bool equipped, bool locked,
        uint256 usage, uint256 currentPrice, uint256 lastSoldTime
    ) {
        ArtifactData memory a = artifacts[tokenId];
        PriceData memory p = priceHistory[tokenId];
        return (a.tier, a.boostBps, a.equipped, isLocked[tokenId], usageCount[tokenId], getCurrentPrice(tokenId), p.lastSoldTime);
    }
    
    // ═══════════════════════════════════════════════════════════════════════
    //                          INDIVIDUAL MARKETPLACE
    // ═══════════════════════════════════════════════════════════════════════
    
    /**
     * @dev Get all token IDs available in a tier's pool
     * Used by frontend to display individual NFTs for sale
     */
    function getPoolTokenIds(ArtifactTier tier) external view returns (uint256[] memory) {
        if (tier == ArtifactTier.LUNAR_DUST) return poolLunarDust;
        if (tier == ArtifactTier.COSMIC_SHARD) return poolCosmicShard;
        if (tier == ArtifactTier.SOLAR_CORE) return poolSolarCore;
        return poolVoidAnomaly;
    }
    
    /**
     * @dev Buy a specific NFT by tokenId (for Individual Marketplace)
     * Allows users to choose exact NFT they want
     */
    function buySpecificArtifact(uint256 tokenId, address referrer) external payable nonReentrant {
        require(initialized, "Not initialized");
        require(referrer != msg.sender, "Self-ref");
        require(ownerOf(tokenId) == address(this), "Not in pool");
        
        ArtifactTier tier = artifacts[tokenId].tier;
        uint256 price = getCurrentPrice(tokenId);
        require(msg.value >= price, "Insufficient");
        
        // Remove from pool
        _removeSpecificFromPool(tokenId, tier);
        
        // Update price for next sale
        uint256 nextPrice = tier == ArtifactTier.LUNAR_DUST 
            ? BASE_PRICE_LUNAR_DUST 
            : price + (price * PRICE_STEP_BPS) / BPS_BASE;
            
        priceHistory[tokenId] = PriceData(nextPrice, block.timestamp);
        
        _distributeFunds(price, referrer);
        _transfer(address(this), msg.sender, tokenId);
        
        totalSales++;
        totalVolume += price;
        
        if (msg.value > price) {
            (bool okRef, ) = payable(msg.sender).call{value: msg.value - price}("");
            require(okRef, "Refund failed");
        }
        emit ArtifactPurchased(msg.sender, tokenId, price, referrer);
    }
    
    /**
     * @dev Remove a specific tokenId from its pool
     */
    function _removeSpecificFromPool(uint256 tokenId, ArtifactTier tier) internal {
        uint256[] storage pool;
        if (tier == ArtifactTier.LUNAR_DUST) pool = poolLunarDust;
        else if (tier == ArtifactTier.COSMIC_SHARD) pool = poolCosmicShard;
        else if (tier == ArtifactTier.SOLAR_CORE) pool = poolSolarCore;
        else pool = poolVoidAnomaly;
        
        // Find and remove the tokenId
        for (uint256 i = 0; i < pool.length; i++) {
            if (pool[i] == tokenId) {
                // Swap with last and pop
                pool[i] = pool[pool.length - 1];
                pool.pop();
                return;
            }
        }
        revert("Token not in pool");
    }
    
    /**
     * @dev Get cheapest NFT in a tier (for Quick Buy display)
     */
    function getCheapestInTier(ArtifactTier tier) external view returns (uint256 tokenId, uint256 price) {
        uint256[] memory pool;
        if (tier == ArtifactTier.LUNAR_DUST) pool = poolLunarDust;
        else if (tier == ArtifactTier.COSMIC_SHARD) pool = poolCosmicShard;
        else if (tier == ArtifactTier.SOLAR_CORE) pool = poolSolarCore;
        else pool = poolVoidAnomaly;
        
        if (pool.length == 0) return (0, 0);
        
        uint256 cheapestId = pool[0];
        uint256 cheapestPrice = getCurrentPrice(pool[0]);
        
        for (uint256 i = 1; i < pool.length; i++) {
            uint256 p = getCurrentPrice(pool[i]);
            if (p < cheapestPrice) {
                cheapestPrice = p;
                cheapestId = pool[i];
            }
        }
        
        return (cheapestId, cheapestPrice);
    }
}
