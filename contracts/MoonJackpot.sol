// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./MoonGameBase.sol";

/**
 * @title MoonJackpot
 * @notice Multiplayer Jackpot game - Many enter, one wins
 *
 * Mechanics:
 *   - Players deposit any amount of XNT
 *   - Timer: 2 minutes after first deposit
 *   - Winner gets 95% of pot
 *   - 5% to XNT Reward Vault (flywheel) via MoonGameBase._distributeFees()
 */
contract MoonJackpot is MoonGameBase {
    
    // ═══════════════════════════════════════════════════════════════════════
    //                              CONSTANTS
    // ═══════════════════════════════════════════════════════════════════════
    
    uint256 public constant MIN_DEPOSIT = 1 ether;      // 1 XNT minimum
    uint256 public constant ROUND_DURATION = 2 minutes;
    uint256 public constant WINNER_SHARE_BPS = 9500;    // 95% to winner
    uint256 public constant POOL_SHARE_BPS = 500;       // 5% to Reward Vault (flywheel)
    // BPS_BASE = 10000 inherited from MoonGameBase
    
    // ═══════════════════════════════════════════════════════════════════════
    //                              STATE
    // ═══════════════════════════════════════════════════════════════════════

    // PULL PATTERN
    mapping(address => uint256) public pendingWinnings;
    
    struct Round {
        uint256 startTime;
        uint256 endTime;
        uint256 totalPot;
        uint256 totalEntries;
        address winner;
        bool finalized;
    }
    
    struct Entry {
        address player;
        uint256 amount;
        uint256 rangeStart;
        uint256 rangeEnd;
    }
    
    uint256 public currentRound;
    mapping(uint256 => Round) public rounds;
    mapping(uint256 => Entry[]) public roundEntries;
    mapping(uint256 => mapping(address => uint256)) public playerDeposits;
    
    // Stats
    uint256 public totalRounds;
    uint256 public totalVolume;
    uint256 public totalPaidOut;
    
    // ═══════════════════════════════════════════════════════════════════════
    //                              EVENTS
    // ═══════════════════════════════════════════════════════════════════════
    
    event PlayerJoined(uint256 indexed round, address indexed player, uint256 amount, uint256 totalPot);
    event RoundFinalized(uint256 indexed round, address indexed winner, uint256 prize, uint256 toPool);
    event NewRoundStarted(uint256 indexed round);
    event WinningsClaimed(address indexed player, uint256 amount);
    
    // ═══════════════════════════════════════════════════════════════════════
    //                              CONSTRUCTOR
    // ═══════════════════════════════════════════════════════════════════════
    
    constructor(address _vault, address _oracle) MoonGameBase(_vault, _oracle) {
        _startNewRound();
    }
    
    // ═══════════════════════════════════════════════════════════════════════
    //                              JOIN GAME
    // ═══════════════════════════════════════════════════════════════════════
    
    /**
     * @notice Join the current jackpot round
     */
    function join() external payable nonReentrant whenNotPaused {
        require(msg.value >= MIN_DEPOSIT, "Min 1 XNT");
        
        Round storage round = rounds[currentRound];
        
        // Check if round needs to be finalized first
        if (round.totalEntries > 0 && block.timestamp >= round.endTime) {
            _finalizeRound();
            // Start new round and join it
            round = rounds[currentRound];
        }
        
        // If first entry, set timer
        if (round.totalEntries == 0) {
            round.startTime = block.timestamp;
            round.endTime = block.timestamp + ROUND_DURATION;
        }
        
        // Add entry with range for weighted random
        uint256 rangeStart = round.totalPot;
        uint256 rangeEnd = round.totalPot + msg.value;
        
        roundEntries[currentRound].push(Entry({
            player: msg.sender,
            amount: msg.value,
            rangeStart: rangeStart,
            rangeEnd: rangeEnd
        }));
        
        round.totalPot += msg.value;
        round.totalEntries++;
        playerDeposits[currentRound][msg.sender] += msg.value;
        totalVolume += msg.value;
        
        emit PlayerJoined(currentRound, msg.sender, msg.value, round.totalPot);
    }
    
    // ═══════════════════════════════════════════════════════════════════════
    //                              FINALIZE
    // ═══════════════════════════════════════════════════════════════════════
    
    /**
     * @notice Finalize the current round (anyone can call after timer)
     */
    function finalize() external nonReentrant whenNotPaused {
        Round storage round = rounds[currentRound];
        require(round.totalEntries > 0, "No entries");
        require(block.timestamp >= round.endTime, "Round active");
        require(!round.finalized, "Already finalized");
        
        _finalizeRound();
    }
    
    function _finalizeRound() internal {
        Round storage round = rounds[currentRound];
        if (round.finalized || round.totalEntries == 0) {
            _startNewRound();
            return;
        }
        
        // Pick winner based on weighted random
        uint256 winningTicket = _pseudoRandom(round.totalPot);
        address winner = _findWinner(currentRound, winningTicket);
        
        // Calculate payouts
        uint256 winnerPrize = (round.totalPot * WINNER_SHARE_BPS) / BPS_BASE;
        uint256 toPool = round.totalPot - winnerPrize;
        
        round.winner = winner;
        round.finalized = true;
        totalRounds++;
        
        // PAYOUT STRATEGY: Pull Payment
        // We do NOT send funds to winner here to prevent DOS
        pendingWinnings[winner] += winnerPrize;
        totalPaidOut += winnerPrize;
        
        // Send 5% to Reward Vault (flywheel)
        if (toPool > 0) {
            _distributeFees(toPool);
        }
        
        emit RoundFinalized(currentRound, winner, winnerPrize, toPool);
        
        _startNewRound();
    }
    
    function _findWinner(uint256 roundId, uint256 ticket) internal view returns (address) {
        Entry[] storage entries = roundEntries[roundId];
        for (uint256 i = 0; i < entries.length; i++) {
            if (ticket >= entries[i].rangeStart && ticket < entries[i].rangeEnd) {
                return entries[i].player;
            }
        }
        // Fallback to last entry
        return entries[entries.length - 1].player;
    }
    
    function _startNewRound() internal {
        currentRound++;
        emit NewRoundStarted(currentRound);
    }
    
    // ═══════════════════════════════════════════════════════════════════════
    //                              WITHDRAW
    // ═══════════════════════════════════════════════════════════════════════
    
    function claimWinnings() external nonReentrant {
        uint256 amount = pendingWinnings[msg.sender];
        require(amount > 0, "No winnings");
        
        pendingWinnings[msg.sender] = 0;
        
        (bool success, ) = payable(msg.sender).call{value: amount}("");
        require(success, "Transfer failed");
        
        emit WinningsClaimed(msg.sender, amount);
    }
    
    // ═══════════════════════════════════════════════════════════════════════
    //                              VIEW
    // ═══════════════════════════════════════════════════════════════════════
    
    function getCurrentRoundInfo() external view returns (
        uint256 roundId,
        uint256 pot,
        uint256 entries,
        uint256 timeRemaining,
        bool canFinalize
    ) {
        Round storage round = rounds[currentRound];
        roundId = currentRound;
        pot = round.totalPot;
        entries = round.totalEntries;
        timeRemaining = block.timestamp < round.endTime ? round.endTime - block.timestamp : 0;
        canFinalize = round.totalEntries > 0 && block.timestamp >= round.endTime && !round.finalized;
    }
    
    function getPlayerChance(uint256 roundId, address player) external view returns (uint256 chanceBps) {
        Round storage round = rounds[roundId];
        if (round.totalPot == 0) return 0;
        return (playerDeposits[roundId][player] * BPS_BASE) / round.totalPot;
    }
    
    function getRoundEntries(uint256 roundId) external view returns (Entry[] memory) {
        return roundEntries[roundId];
    }
    
    // ═══════════════════════════════════════════════════════════════════════
    //                              INTERNAL
    // ═══════════════════════════════════════════════════════════════════════
    
    function _pseudoRandom(uint256 max) internal view override returns (uint256) {
        return uint256(keccak256(abi.encodePacked(
            block.timestamp,
            block.prevrandao,
            msg.sender,
            currentRound,
            rounds[currentRound].totalPot
        ))) % max;
    }
    
    // ═══════════════════════════════════════════════════════════════════════
    //                              ADMIN
    // ═══════════════════════════════════════════════════════════════════════
    
    // MoonGameBase provides: pauseGame(), unpauseGame()

    receive() external payable {}
}
