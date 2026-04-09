// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";

// Interfaces
interface IMoonArtifacts {
    function isEquipped(address user) external view returns (bool);
    function lockArtifact(address user) external returns (uint256 tokenId, uint256 boostBps);
    function restockArtifact(uint256 tokenId) external;
}

interface IDevEscrow {
    function deposit() external payable;
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *                           MOON FORGE BASE v7.1
 *                    THE COMMUNITY GOVERNANCE UPDATE
 * ═══════════════════════════════════════════════════════════════════════════
 * 
 * ⚖️ v9.0 FEE STRUCTURE (100% — applied to early-exit penalties):
 *
 *   With referrer:    93.5% pool | 1.0% oracle | 2.0% referrer | 2.0% dev | 1.5% escrow
 *   Without referrer: 95.5% pool | 1.0% oracle |               | 2.0% dev | 1.5% escrow
 *
 *   dev (2.0%): DEV_WALLET — hardcode before open-source for fork-protection.
 *   escrow (1.5%): DevEscrow — returned to pool every 4 epochs if growth ≥ 95% of prev cycle.
 *
 * 🔒 LOGIC (v6.0 + v7.1):
 * - Merkle Proof Vesting
 * - Lock/Release of NFTs via MoonArtifacts
 * - Penalty distribution matches Artifacts split
 */

// NOTE: Owner must call renounceOwnership() after setArtifactsContract() is called.
contract MoonForgeBase is ReentrancyGuard, Ownable, IERC721Receiver {
    
    // ═══════════════════════════════════════════════════════════════════════
    //                              CONSTANTS
    // ═══════════════════════════════════════════════════════════════════════
    
    uint256 public constant BPS_BASE = 10000;
    
    // Fee splits v9.0 (MUST SUM TO 10000 in each case)
    // Applied to PENALTIES in this contract (ejectPilot)
    // With referrer:    9350 + 100 + 200 + 200 + 150 = 10000
    // Without referrer: 9550 + 100 +       200 + 150 = 10000
    uint256 public constant POOL_SHARE_BPS = 9350;        // 93.5% (with referrer)
    uint256 public constant NO_REF_POOL_SHARE_BPS = 9550; // 95.5% (no referrer — absorbs ref share)
    uint256 public constant ORACLE_GAS_BPS = 100;         // 1.0%
    uint256 public constant REF_SHARE_BPS = 200;          // 2.0%
    uint256 public constant DEV_SHARE_BPS = 200;          // 2.0% → direct to dev (symmetric with referrer)
    uint256 public constant ESCROW_SHARE_BPS = 150;       // 1.5% → DevEscrow (community incentive pool)

    // Vesting Durations
    uint256 public constant TIER_0_DURATION = 5 days;
    uint256 public constant TIER_1_DURATION = 45 days;
    uint256 public constant TIER_2_DURATION = 180 days;
    
    // Penalty Rates
    uint256 public constant TIER_0_PENALTY = 0;        // 0%
    uint256 public constant TIER_1_PENALTY = 2000;     // 20%
    uint256 public constant TIER_2_PENALTY = 5000;     // 50%
    
    // ═══════════════════════════════════════════════════════════════════════
    //                              STATE
    // ═══════════════════════════════════════════════════════════════════════
    
    address public immutable devWallet;   // 2.0% direct — hardcode as constant before open-sourcing
    address public immutable devEscrow;   // 1.5% cycle incentive → DevEscrow contract
    address public immutable oracleWallet;
    IMoonArtifacts public artifactsContract;

    bytes32 public merkleRoot;
    uint256 public currentEpoch;

    /// @notice XNT allocated per epoch — read by DevEscrow to measure growth without oracle trust.
    mapping(uint256 => uint256) public epochVolume;
    
    struct VestingInfo {
        uint256 totalAmount;
        uint256 claimedAmount;
        uint256 startTime;
        uint256 endTime;
        uint8 tier;
        address referrer; // Tracked here for penalty split
        bool initialized;
        uint256 lockedArtifactId; // v6.0
    }
    
    mapping(address => VestingInfo) public vestings;
    
    // ═══════════════════════════════════════════════════════════════════════
    //                              EVENTS
    // ═══════════════════════════════════════════════════════════════════════
    
    event MissionInitialized(address indexed pilot, uint256 amount, uint256 bonus, uint256 lockedArtifact);
    event VestedClaimed(address indexed pilot, uint256 amount);
    event PilotEjected(address indexed pilot, uint256 penalty, uint256 returned);
    event EpochUpdated(uint256 indexed epoch, bytes32 root);
    event Donated(address indexed donor, uint256 amount); // 100% to reward pool — no split
    
    // ═══════════════════════════════════════════════════════════════════════
    //                              CONSTRUCTOR
    // ═══════════════════════════════════════════════════════════════════════
    
    constructor(address _devWallet, address _devEscrow, address _oracleWallet) Ownable() {
        require(_devWallet != address(0), "Invalid devWallet");
        require(_devEscrow != address(0), "Invalid devEscrow");
        require(_oracleWallet != address(0), "Invalid oracleWallet");
        devWallet = _devWallet;
        devEscrow = _devEscrow;
        oracleWallet = _oracleWallet;
    }
    
    // ═══════════════════════════════════════════════════════════════════════
    //                              ADMIN
    // ═══════════════════════════════════════════════════════════════════════
    
    /// @notice ONE-TIME ONLY. Call renounceOwnership() immediately after.
    ///         Once artifacts contract is set it cannot be replaced.
    ///         Prevents swapping in a malicious NFT contract post-launch.
    function setArtifactsContract(address _artifacts) external onlyOwner {
        require(address(artifactsContract) == address(0), "Artifacts already set");
        artifactsContract = IMoonArtifacts(_artifacts);
    }

    // CALLED BY ORACLE
    function updateEpoch(uint256 epoch, bytes32 root) external {
        require(msg.sender == oracleWallet, "Only Oracle");
        require(epoch > currentEpoch, "Old epoch");
        currentEpoch = epoch;
        merkleRoot = root;
        emit EpochUpdated(epoch, root);
    }
    
    // ═══════════════════════════════════════════════════════════════════════
    //                              MISSION CONTROL
    // ═══════════════════════════════════════════════════════════════════════
    
    function initializeMission(
        uint256 amount,
        uint8 tier,
        address referrer,
        bytes32[] calldata proof
    ) external nonReentrant {
        require(!vestings[msg.sender].initialized, "Active mission");

        // Verify Merkle — leaf matches oracle: solidityPacked(['address','uint256','uint8'], [pilot, amount, tier])
        bytes32 leaf = keccak256(abi.encodePacked(msg.sender, amount, tier));
        require(MerkleProof.verify(proof, merkleRoot, leaf), "Invalid proof");

        // Track volume for DevEscrow cycle goal — trustless, no oracle input needed
        epochVolume[currentEpoch] += amount;

        // Duration
        uint256 duration = tier == 0 ? TIER_0_DURATION : (tier == 1 ? TIER_1_DURATION : TIER_2_DURATION);
        
        // Lock NFT & Calc Bonus
        uint256 bonusBps = 0;
        uint256 artifactId = 0;
        if (address(artifactsContract) != address(0)) {
            if (artifactsContract.isEquipped(msg.sender)) {
                (artifactId, bonusBps) = artifactsContract.lockArtifact(msg.sender);
            }
        }
        
        uint256 total = amount + (amount * bonusBps) / BPS_BASE;
        require(address(this).balance >= total, "Vault dry");
        
        vestings[msg.sender] = VestingInfo({
            totalAmount: total,
            claimedAmount: 0,
            startTime: block.timestamp,
            endTime: block.timestamp + duration,
            tier: tier,
            referrer: referrer,
            initialized: true,
            lockedArtifactId: artifactId
        });
        
        emit MissionInitialized(msg.sender, total, bonusBps, artifactId);
    }
    
    function claimVested() external nonReentrant {
        VestingInfo storage v = vestings[msg.sender];
        require(v.initialized, "No mission");
        
        uint256 claimable = getClaimable(msg.sender);
        require(claimable > 0, "Nothing claimable");
        
        v.claimedAmount += claimable;
        
        // Mission Complete?
        if (v.claimedAmount >= v.totalAmount) {
            // Unlock NFT
            if (v.lockedArtifactId != 0 && address(artifactsContract) != address(0)) {
                artifactsContract.restockArtifact(v.lockedArtifactId);
            }
            delete vestings[msg.sender];
        }
        
        (bool ok, ) = payable(msg.sender).call{value: claimable}("");
        require(ok, "Claim transfer failed");
        emit VestedClaimed(msg.sender, claimable);
    }
    
    function ejectPilot() external nonReentrant {
        VestingInfo storage v = vestings[msg.sender];
        require(v.initialized, "No mission");
        
        uint256 remaining = v.totalAmount - v.claimedAmount;
        uint256 penaltyBps = _getPenaltyBps(v.tier);
        uint256 penaltyAmount = (remaining * penaltyBps) / BPS_BASE;
        uint256 userAmount = remaining - penaltyAmount; // User gets 50% or 80% (or 100% if tier 0)
        
        // Distribute Penalty (v7.1 Split)
        // 95.5% stays in Vault (Pool Share) - effectively burned from user perspective but stays in contract
        // Ref/Arch/Oracle take their cut from the penalty 
        
        if (penaltyAmount > 0) {
            // v9.0 split:
            //   With ref:    93.5% pool + 1.0% oracle + 2.0% ref + 2.0% dev + 1.5% escrow
            //   Without ref: 95.5% pool + 1.0% oracle +            2.0% dev + 1.5% escrow
            // Pool share stays in contract balance automatically.

            uint256 oracleShare  = (penaltyAmount * ORACLE_GAS_BPS) / BPS_BASE;  // 1.0%
            uint256 devShare     = (penaltyAmount * DEV_SHARE_BPS)   / BPS_BASE;  // 2.0%
            uint256 escrowShare  = (penaltyAmount * ESCROW_SHARE_BPS) / BPS_BASE; // 1.5%
            uint256 refShare     = v.referrer != address(0)
                                     ? (penaltyAmount * REF_SHARE_BPS) / BPS_BASE // 2.0%
                                     : 0; // no referrer → those 2% stay in pool (95.5%)

            if (oracleShare > 0) {
                (bool okO, ) = payable(oracleWallet).call{value: oracleShare}("");
                require(okO, "Oracle transfer failed");
            }
            if (refShare > 0) {
                (bool okR, ) = payable(v.referrer).call{value: refShare}("");
                require(okR, "Referrer transfer failed");
            }
            if (devShare    > 0) {
                (bool ok1, ) = payable(devWallet).call{value: devShare}("");
                require(ok1, "Dev transfer failed");
            }
            if (escrowShare > 0) {
                IDevEscrow(devEscrow).deposit{value: escrowShare}();
            }
            // Remaining (pool share) stays in contract balance
        }
        
        // Unlock NFT
        if (v.lockedArtifactId != 0 && address(artifactsContract) != address(0)) {
            artifactsContract.restockArtifact(v.lockedArtifactId);
        }
        
        delete vestings[msg.sender];
        
        if (userAmount > 0) {
            (bool okU, ) = payable(msg.sender).call{value: userAmount}("");
            require(okU, "User return failed");
        }
        
        emit PilotEjected(msg.sender, penaltyAmount, userAmount);
    }
    
    // ═══════════════════════════════════════════════════════════════════════
    //                              HELPERS
    // ═══════════════════════════════════════════════════════════════════════
    
    function getClaimable(address pilot) public view returns (uint256) {
        VestingInfo memory v = vestings[pilot];
        if (!v.initialized) return 0;
        
        if (block.timestamp >= v.endTime) {
            return v.totalAmount - v.claimedAmount;
        }
        
        uint256 duration = v.endTime - v.startTime;
        uint256 elapsed = block.timestamp - v.startTime;
        
        uint256 vested = (v.totalAmount * elapsed) / duration;
        return vested > v.claimedAmount ? vested - v.claimedAmount : 0;
    }
    
    function _getPenaltyBps(uint8 tier) internal pure returns (uint256) {
        if (tier == 0) return TIER_0_PENALTY;
        if (tier == 1) return TIER_1_PENALTY;
        return TIER_2_PENALTY;
    }
    
    // Required for receiving NFTs
    function onERC721Received(address, address, uint256, bytes calldata) external pure override returns (bytes4) {
        return IERC721Receiver.onERC721Received.selector;
    }
    
    // ═══════════════════════════════════════════════════════════════════════
    //                              DONATIONS
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * @notice Donate XNT directly to the reward pool.
     *         100% of the donation goes to the pool — no fee split whatsoever.
     *         Emits Donated so any explorer can verify the exact amount received.
     *
     * @dev The contract balance IS the pool. Sending here increases pool directly.
     *      Unlike ejectPilot(), there is mathematically no path for any fee to be
     *      deducted — this function only accepts and records, never distributes.
     */
    function donate() external payable {
        require(msg.value > 0, "Donation must be > 0");
        emit Donated(msg.sender, msg.value);
        // msg.value stays in contract balance = reward pool. No transfer out.
    }

    receive() external payable {}
}
