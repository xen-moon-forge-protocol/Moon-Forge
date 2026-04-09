// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/security/Pausable.sol";
import "./MoonGameBase.sol";

/**
 * @title MoonGames
 * @notice Simple betting games for Moon Forge (XNT Native Token)
 * 
 * Games:
 *   1. Coin Flip - 50/50, 1.96x payout
 *   2. High-Low - Guess if next number is higher or lower
 *
 * Revenue Split:
 *   - 1% to Pool
 *   - 1% to Oracle/Gas
 */
contract MoonGames is MoonGameBase {
    
    // ═══════════════════════════════════════════════════════════════════════
    //                              CONSTANTS
    // ═══════════════════════════════════════════════════════════════════════
    
    // Note: 'ether' keyword in Solidity just means 10^18 units.
    // It works perfectly for XNT (18 decimals).
    uint256 public constant MIN_BET = 0.1 ether;              // 0.1 XNT minimum
    uint256 public constant MAX_BET = 100 ether;              // 100 XNT maximum
    // House edges per game — 100% of edge goes to reward pool via MoonGameBase._distributeFees()
    uint256 public constant COIN_FLIP_EDGE_BPS  = 350;        // 3.5% — Coin Flip
    uint256 public constant HIGH_LOW_EDGE_BPS   = 400;        // 4.0% — High-Low
    
    // ═══════════════════════════════════════════════════════════════════════
    //                              STATE
    // ═══════════════════════════════════════════════════════════════════════
    
    mapping(address => uint256) public winnings;
    
    // Stats
    uint256 public totalGamesPlayed;
    uint256 public totalVolume;
    uint256 public totalPaidOut;
    
    // High-Low state
    uint256 public currentNumber;
    uint256 public lastUpdateBlock;
    
    // ═══════════════════════════════════════════════════════════════════════
    //                              EVENTS
    // ═══════════════════════════════════════════════════════════════════════
    
    event CoinFlipResult(address indexed player, uint256 bet, bool guessedHeads, bool wasHeads, bool won, uint256 payout);
    event HighLowResult(address indexed player, uint256 bet, bool guessedHigh, uint256 oldNum, uint256 newNum, bool won, uint256 payout);
    event WinningsClaimed(address indexed player, uint256 amount);
    
    // ═══════════════════════════════════════════════════════════════════════
    //                              CONSTRUCTOR
    // ═══════════════════════════════════════════════════════════════════════
    
    constructor(address _vault, address _oracle) MoonGameBase(_vault, _oracle) {
        currentNumber = _pseudoRandom(100) + 1; // Start at 1-100
        lastUpdateBlock = block.number;
    }
    
    // ═══════════════════════════════════════════════════════════════════════
    //                              COIN FLIP
    // ═══════════════════════════════════════════════════════════════════════
    
    /**
     * @notice Play Coin Flip - guess heads (true) or tails (false)
     * @param guessHeads true = heads, false = tails
     */
    function playCoinFlip(bool guessHeads) external payable nonReentrant whenNotPaused {
        require(msg.value >= MIN_BET && msg.value <= MAX_BET, "Invalid bet");
        
        // Generate result
        bool isHeads = _pseudoRandom(2) == 1;
        bool won = (guessHeads == isHeads);
        
        // Edge = 3.5% of bet, taken regardless of win/lose → 100% to reward pool
        uint256 houseEdge = (msg.value * COIN_FLIP_EDGE_BPS) / BPS_BASE;

        uint256 payout = 0;
        if (won) {
            // Win: player gets back 2× bet minus the edge
            payout = msg.value * 2 - houseEdge;
            require(address(this).balance >= payout, "Insufficient balance");
            // PULL PATTERN: user calls claimWinnings()
            winnings[msg.sender] += payout;
            totalPaidOut += payout;
        }
        // Lose: bet stays in contract reserve; only edge goes to pool
        _distributeFees(houseEdge);
        
        totalGamesPlayed++;
        totalVolume += msg.value;
        
        emit CoinFlipResult(msg.sender, msg.value, guessHeads, isHeads, won, payout);
    }
    
    // ═══════════════════════════════════════════════════════════════════════
    //                              HIGH-LOW
    // ═══════════════════════════════════════════════════════════════════════
    
    /**
     * @notice Play High-Low - guess if next number will be higher or lower
     * @param guessHigh true = higher, false = lower
     */
    function playHighLow(bool guessHigh) external payable nonReentrant whenNotPaused {
        require(msg.value >= MIN_BET && msg.value <= MAX_BET, "Invalid bet");
        // Boundary guard: prevent impossible bets that trigger degenerate multipliers
        if (guessHigh) require(currentNumber < 100, "Current number is max (100), cannot guess higher");
        else           require(currentNumber > 1,   "Current number is min (1), cannot guess lower");

        uint256 oldNumber = currentNumber;
        uint256 newNumber = _pseudoRandom(100) + 1; // 1-100
        
        // Update state
        currentNumber = newNumber;
        lastUpdateBlock = block.number;
        
        // Determine win
        bool won;
        if (newNumber == oldNumber) {
            won = false; // Tie = loss
        } else if (guessHigh) {
            won = newNumber > oldNumber;
        } else {
            won = newNumber < oldNumber;
        }
        
        // Edge = 4% of bet → 100% to reward pool
        uint256 houseEdge = (msg.value * HIGH_LOW_EDGE_BPS) / BPS_BASE;

        // Calculate payout based on probability
        uint256 payout = 0;
        if (won) {
            uint256 multiplier = _calculateHighLowMultiplier(oldNumber, guessHigh);
            payout = (msg.value * multiplier) / BPS_BASE;
            require(address(this).balance >= payout, "Insufficient balance");
            // PULL PATTERN
            winnings[msg.sender] += payout;
            totalPaidOut += payout;
        }

        _distributeFees(houseEdge);
        
        totalGamesPlayed++;
        totalVolume += msg.value;
        
        emit HighLowResult(msg.sender, msg.value, guessHigh, oldNumber, newNumber, won, payout);
    }
    
    /**
     * @dev Calculate multiplier for High-Low based on current number
     * Higher risk = higher reward
     */
    function _calculateHighLowMultiplier(uint256 number, bool guessHigh) internal pure returns (uint256) {
        uint256 probability;
        
        if (guessHigh) {
            // Probability of getting higher = (100 - number) / 99
            probability = 100 - number;
        } else {
            // Probability of getting lower = (number - 1) / 99
            probability = number - 1;
        }
        
        if (probability == 0) probability = 1; // Avoid division by zero
        
        // Fair multiplier = 100/probability, reduced by 4% house edge
        uint256 fairMultiplier = (100 * BPS_BASE) / probability;
        return (fairMultiplier * (BPS_BASE - HIGH_LOW_EDGE_BPS)) / BPS_BASE;
    }
    
    /**
     * @notice Get current High-Low number and expected multipliers
     */
    function getHighLowInfo() external view returns (
        uint256 number,
        uint256 highMultiplier,
        uint256 lowMultiplier
    ) {
        number = currentNumber;
        highMultiplier = _calculateHighLowMultiplier(currentNumber, true);
        lowMultiplier = _calculateHighLowMultiplier(currentNumber, false);
    }
    
    // ═══════════════════════════════════════════════════════════════════════
    //                              WITHDRAWALS
    // ═══════════════════════════════════════════════════════════════════════
    
    /**
     * @notice Build-up winnings withdrawal
     */
    function claimWinnings() external nonReentrant {
        uint256 amount = winnings[msg.sender];
        require(amount > 0, "No winnings");
        
        winnings[msg.sender] = 0;
        
        (bool success, ) = payable(msg.sender).call{value: amount}("");
        require(success, "Transfer failed");
        
        emit WinningsClaimed(msg.sender, amount);
    }
    
    // ═══════════════════════════════════════════════════════════════════════
    //                              INTERNAL
    // ═══════════════════════════════════════════════════════════════════════
    
    // ═══════════════════════════════════════════════════════════════════════
    //                              INTERNAL
    // ═══════════════════════════════════════════════════════════════════════
    
    // MoonGameBase handles _distributeFees (The Flywheel)
    
    function _pseudoRandom(uint256 max) internal view override returns (uint256) {
        // Simple pseudo-random for demo - NOT secure for mainnet
        // Will use Chainlink VRF or similar for production
        return uint256(keccak256(abi.encodePacked(
            block.timestamp,
            block.prevrandao,
            msg.sender,
            totalGamesPlayed
        ))) % max;
    }
    
    // ═══════════════════════════════════════════════════════════════════════
    //                              ADMIN
    // ═══════════════════════════════════════════════════════════════════════
    
    // MoonGameBase provides: pauseGame(), unpauseGame()

    /// @notice Deposit funds to pay out winners
    function deposit() external payable {}

    receive() external payable {}
}
