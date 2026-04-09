// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *                           MOON FORGE PORTAL
 * ═══════════════════════════════════════════════════════════════════════════
 * 
 * The entry gate where Pilots burn XEN to start their Moon Mission.
 * Deployed on EVM chains (Ethereum, Optimism).
 * 
 * This contract is IMMUTABLE. No admin keys. No upgrades. Pure burn.
 * "Don't wait for the party. Forge it."
 *
 * ─── TRANSPARENCY ───────────────────────────────────────────────────────────
 * REFERRERS: Pass any wallet as `referrer`. That address earns 2% of any
 * penalty paid by the users you bring, routed via MoonForgeBase.ejectPilot().
 * This contract records the referrer in the emitted event — no storage kept here.
 *
 * FORKS: xenToken is immutable — set at deploy, never changeable.
 * No owner, no admin functions. This contract cannot be paused or upgraded.
 * ────────────────────────────────────────────────────────────────────────────
 */

interface IBurnableToken {
    function burn(address user, uint256 amount) external;
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

contract MoonForgePortal is ReentrancyGuard {
    
    // ═══════════════════════════════════════════════════════════════════════
    //                              CONSTANTS
    // ═══════════════════════════════════════════════════════════════════════
    
    address public constant DEAD_ADDRESS = 0x000000000000000000000000000000000000dEaD;
    
    // ═══════════════════════════════════════════════════════════════════════
    //                              STATE
    // ═══════════════════════════════════════════════════════════════════════
    
    IBurnableToken public immutable xenToken;
    
    uint256 public totalBurned;
    uint256 public totalMissions;
    
    // ═══════════════════════════════════════════════════════════════════════
    //                              EVENTS
    // ═══════════════════════════════════════════════════════════════════════
    
    event MissionStarted(
        address indexed pilot,
        uint256 amount,
        uint8 indexed missionTier,
        string x1TargetAddress,
        address referrer,
        uint256 timestamp
    );
    
    // ═══════════════════════════════════════════════════════════════════════
    //                              CONSTRUCTOR
    // ═══════════════════════════════════════════════════════════════════════
    
    constructor(address _xenToken) {
        require(_xenToken != address(0), "Invalid XEN address");
        xenToken = IBurnableToken(_xenToken);
    }
    
    // ═══════════════════════════════════════════════════════════════════════
    //                              MAIN FUNCTIONS
    // ═══════════════════════════════════════════════════════════════════════
    
    /**
     * @notice Enter the Forge - Burn XEN to earn XNT on X1
     * @param amount Amount of XEN to burn
     * @param missionTier 0=Launchpad(5d), 1=Orbit(45d), 2=MoonLanding(180d)
     * @param x1TargetAddress Your X1 wallet address in Base58 format (Solana/SVM public key).
     *        X1 runs the Solana Virtual Machine (SVM) — this is NOT an EVM 0x address.
     *        Copy your address from the official X1 Wallet or Backpack (set X1 RPC in Backpack settings).
     *        Example: "7xLk17EQQ5KLDLDe44wCmupJKJjTGd8hs3eSVVhCx19" (32-44 chars, Base58)
     *        The oracle reads this address from the event to build the Merkle leaf for X1.
     * @param referrer Optional referrer EVM address for fee split
     */
    function enterForge(
        uint256 amount,
        uint8 missionTier,
        string calldata x1TargetAddress,
        address referrer
    ) external nonReentrant {
        require(amount > 0, "Amount must be > 0");
        require(missionTier <= 2, "Invalid tier");
        // x1TargetAddress = Base58 Solana public key (X1 SVM address, 32-44 chars)
        uint256 addrLen = bytes(x1TargetAddress).length;
        require(addrLen >= 32 && addrLen <= 44, "x1Address must be Base58 format (32-44 chars, from X1 Wallet)");
        require(referrer != msg.sender, "Cannot refer yourself");
        
        // Transfer XEN to dead address (permanent burn)
        bool success = xenToken.transferFrom(msg.sender, DEAD_ADDRESS, amount);
        require(success, "Transfer failed");
        
        // Update stats
        totalBurned += amount;
        totalMissions++;
        
        // Emit event for Oracle to read
        emit MissionStarted(
            msg.sender,
            amount,
            missionTier,
            x1TargetAddress,
            referrer,
            block.timestamp
        );
    }
    
    /**
     * @notice Convenience function without referrer (backwards compatible)
     */
    function enterForgeSimple(
        uint256 amount,
        uint8 missionTier,
        string calldata x1TargetAddress
    ) external nonReentrant {
        require(amount > 0, "Amount must be > 0");
        require(missionTier <= 2, "Invalid tier");
        uint256 simpleAddrLen = bytes(x1TargetAddress).length;
        require(simpleAddrLen >= 32 && simpleAddrLen <= 44, "x1Address must be Base58 format (32-44 chars)");
        
        bool success = xenToken.transferFrom(msg.sender, DEAD_ADDRESS, amount);
        require(success, "Transfer failed");
        
        totalBurned += amount;
        totalMissions++;
        
        emit MissionStarted(
            msg.sender,
            amount,
            missionTier,
            x1TargetAddress,
            address(0), // No referrer
            block.timestamp
        );
    }
    
    // ═══════════════════════════════════════════════════════════════════════
    //                              VIEW FUNCTIONS
    // ═══════════════════════════════════════════════════════════════════════
    
    function getStats() external view returns (uint256 burned, uint256 missions) {
        return (totalBurned, totalMissions);
    }
}
