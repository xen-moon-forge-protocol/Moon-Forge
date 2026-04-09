// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./MoonGameBase.sol";

/**
 * @title MoonVoidRush
 * @notice "Crash" style game with Instant Target Betting.
 * 
 * MECHANIC:
 * 1. Player sets a Target Multiplier (e.g., 2.00x).
 * 2. Contract calculates Win Probability based on Target + House Edge.
 * 3. RNG determines if the "Ship" reached the target or crashed before.
 * 
 * WHY INSTANT TARGET?
 * Standard "wait and click eject" is impossible on-chain due to block times.
 * This mathematically replicates the same odds/payouts but instantly.
 */
contract MoonVoidRush is MoonGameBase {

    // ═══════════════════════════════════════════════════════════════════════
    //                              CONSTANTS
    // ═══════════════════════════════════════════════════════════════════════

    uint256 public constant MIN_BET = 0.1 ether;
    uint256 public constant MAX_BET = 100 ether;
    uint256 public constant HOUSE_EDGE_BPS = 200; // 2% 
    uint256 public constant MAX_MULTIPLIER_BPS = 10000; // 100x
    uint256 public constant MIN_MULTIPLIER_BPS = 105;   // 1.05x minimum

    // ═══════════════════════════════════════════════════════════════════════
    //                              EVENTS
    // ═══════════════════════════════════════════════════════════════════════

    event VoidRushResult(
        address indexed player, 
        uint256 bet, 
        uint256 targetMultiplierBps, 
        bool won, 
        uint256 payout,
        uint256 crashPointBps // Simulated crash point for UI
    );

    // ═══════════════════════════════════════════════════════════════════════
    //                              CONSTRUCTOR
    // ═══════════════════════════════════════════════════════════════════════

    // PULL PATTERN — winnings credited here, claimed via claimWinnings()
    mapping(address => uint256) public winnings;
    uint256 public totalPaidOut;

    event WinningsClaimed(address indexed player, uint256 amount);

    constructor(address _vault, address _oracle) MoonGameBase(_vault, _oracle) {}

    // ═══════════════════════════════════════════════════════════════════════
    //                              GAME LOGIC
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * @notice Play Void Rush (instant crash game)
     * @param targetBps Target multiplier in basis units: 20000 = 2.0x, 10500 = 1.05x
     * House edge = 2% realized via probability skew.
     * Win Prob = (BPS_BASE / targetBps) × (1 - 0.02)
     */
    function playVoidRush(uint256 targetBps) external payable nonReentrant whenNotPaused {
        require(msg.value >= MIN_BET && msg.value <= MAX_BET, "Invalid bet");
        require(targetBps >= 10500, "Min 1.05x"); // 10500 = 1.05x
        require(targetBps <= 1000000, "Max 100x"); // 1000000 = 100x

        // 1. Calculate Win Chance
        // Probability = 1 / Multiplier
        // With House Edge: Prob = (1 / Multiplier) * (1 - HouseEdge)
        // Example: 2.0x (20000 bps)
        // Prob = (10000 / 20000) * 0.98 = 0.5 * 0.98 = 0.49 (49%)
        
        // Math:
        // Inverse Multiplier: (BPS_BASE * BPS_BASE) / targetBps
        // Apply House Edge: * (BPS_BASE - HOUSE_EDGE) / BPS_BASE
        
        uint256 probability = (BPS_BASE * BPS_BASE) / targetBps; // Raw check
        probability = (probability * (BPS_BASE - HOUSE_EDGE_BPS)) / BPS_BASE;
        
        // 2. Generate Random
        uint256 rng = _pseudoRandom(BPS_BASE); // 0 - 9999
        
        bool won = rng < probability;
        
        uint256 payout = 0;
        uint256 crashPoint = 0;

        if (won) {
            // Player wins: pays target multiplier on the bet
            payout = (msg.value * targetBps) / BPS_BASE;
            require(address(this).balance >= payout, "Insufficient liquidity");
            // PULL PATTERN: credit winnings, user calls claimWinnings()
            winnings[msg.sender] += payout;
            totalPaidOut += payout;
            crashPoint = targetBps + (rng % 5000); // crash above target for UI effect
        } else {
            // Player loses: bet stays in contract as liquidity reserve.
            // House edge is realized via probability skew (2% edge).
            // On loss, send 100% of the bet to Reward Vault (flywheel).
            uint256 diff = targetBps > 10000 ? targetBps - 10000 : 1;
            crashPoint = 10000 + (rng % diff);
            _distributeFees(msg.value); // 100% of loss → XNT Reward Pool
        }

        emit VoidRushResult(msg.sender, msg.value, targetBps, won, payout, crashPoint);
    }

    /**
     * @notice Claim winnings (PULL PATTERN)
     */
    function claimWinnings() external nonReentrant {
        uint256 amount = winnings[msg.sender];
        require(amount > 0, "No winnings");
        winnings[msg.sender] = 0;
        (bool success, ) = payable(msg.sender).call{value: amount}("");
        require(success, "Transfer failed");
        emit WinningsClaimed(msg.sender, amount);
    }

    /// @notice Deposit liquidity to pay out winners
    function deposit() external payable {}

    receive() external payable {}
}
