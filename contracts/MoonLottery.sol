// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/security/Pausable.sol";

/**
 * @title MoonLottery
 * @notice XNT Burn Lottery - Burn XNT for lottery tickets (Native XNT)
 * 
 * Mechanics:
 *   - 10 XNT = 1 ticket
 *   - Weekly draw (7 days per round)
 *   - 80% to winner, 20% burned (sent to dead address 0x000...dEaD)
 *   - The 20% burn permanently reduces XNT supply, making remaining XNT scarcer.
 *   - This is the ONLY game that burns XNT instead of feeding the reward pool.
 */
contract MoonLottery is Ownable, ReentrancyGuard, Pausable {
    
    // ═══════════════════════════════════════════════════════════════════════
    //                              CONSTANTS
    // ═══════════════════════════════════════════════════════════════════════
    
    uint256 public constant TICKET_PRICE = 10 ether;    // 10 XNT per ticket
    uint256 public constant WINNER_SHARE_BPS = 8000;    // 80% to winner
    uint256 public constant BURN_SHARE_BPS = 2000;      // 20% burned (dead address)
    uint256 public constant BPS_BASE = 10000;
    address public constant BURN_ADDRESS = 0x000000000000000000000000000000000000dEaD;
    uint256 public constant ROUND_DURATION = 7 days;
    // If oracle goes offline and fails to draw within this grace period after round end,
    // ticket holders can claim full refunds. Protects users from stuck funds.
    uint256 public constant REFUND_GRACE_PERIOD = 7 days;
    
    // ═══════════════════════════════════════════════════════════════════════
    //                              STATE
    // ═══════════════════════════════════════════════════════════════════════
    
    address public immutable oracleAddress;
    
    // PULL PATTERN
    mapping(address => uint256) public pendingWinnings;
    
    struct Round {
        uint256 startTime;
        uint256 endTime;
        uint256 prizePool;
        uint256 totalTickets;
        address winner;
        bool drawn;
        mapping(uint256 => address) ticketOwners;
    }
    
    uint256 public currentRound;
    mapping(uint256 => Round) public rounds;
    mapping(address => mapping(uint256 => uint256[])) public userTickets; // user => round => ticket IDs
    
    // Stats
    uint256 public totalTicketsBought; // Total XNT spent on tickets
    uint256 public totalBurned;        // Total XNT permanently burned (20% of each prize pool)
    uint256 public totalPaidOut;

    // Emergency refund tracking: user → round → claimed
    mapping(address => mapping(uint256 => bool)) public refundClaimed;
    
    // ═══════════════════════════════════════════════════════════════════════
    //                              EVENTS
    // ═══════════════════════════════════════════════════════════════════════
    
    event TicketPurchased(address indexed buyer, uint256 indexed round, uint256 ticketId, uint256 amountBurned);
    event RoundDrawn(uint256 indexed round, address indexed winner, uint256 prize, uint256 burned);
    event NewRoundStarted(uint256 indexed round, uint256 endTime);
    event WinningsClaimed(address indexed player, uint256 amount);
    event EmergencyRefundClaimed(address indexed player, uint256 indexed round, uint256 amount);
    
    // ═══════════════════════════════════════════════════════════════════════
    //                              CONSTRUCTOR
    // ═══════════════════════════════════════════════════════════════════════
    
    constructor(address _oracle) Ownable() {
        oracleAddress = _oracle;
        _startNewRound();
    }
    
    // ═══════════════════════════════════════════════════════════════════════
    //                              BUY TICKETS
    // ═══════════════════════════════════════════════════════════════════════
    
    /**
     * @notice Buy lottery tickets by spending XNT
     * @param numTickets Number of tickets to buy
     */
    function buyTickets(uint256 numTickets) external payable nonReentrant whenNotPaused {
        require(numTickets > 0 && numTickets <= 100, "1-100 tickets");
        require(block.timestamp < rounds[currentRound].endTime, "Round ended");
        
        uint256 cost = numTickets * TICKET_PRICE;
        require(msg.value >= cost, "Insufficient XNT");
        
        Round storage round = rounds[currentRound];
        
        for (uint256 i = 0; i < numTickets; i++) {
            uint256 ticketId = round.totalTickets;
            round.ticketOwners[ticketId] = msg.sender;
            userTickets[msg.sender][currentRound].push(ticketId);
            round.totalTickets++;
            
            emit TicketPurchased(msg.sender, currentRound, ticketId, TICKET_PRICE);
        }
        
        round.prizePool += cost;
        totalTicketsBought += cost;
        
        // Refund excess
        if (msg.value > cost) {
            (bool success, ) = payable(msg.sender).call{value: msg.value - cost}("");
            require(success, "Refund failed");
        }
    }
    
    // ═══════════════════════════════════════════════════════════════════════
    //                              DRAW
    // ═══════════════════════════════════════════════════════════════════════
    
    /**
     * @notice Draw the winner for current round (callable by oracle)
     */
    function drawWinner() external nonReentrant whenNotPaused {
        require(msg.sender == oracleAddress, "Only oracle");
        
        Round storage round = rounds[currentRound];
        require(block.timestamp >= round.endTime, "Round not ended");
        require(!round.drawn, "Already drawn");
        require(round.totalTickets > 0, "No tickets sold");
        
        // Pick random winner
        uint256 winningTicket = _pseudoRandom(round.totalTickets);
        address winner = round.ticketOwners[winningTicket];
        
        // Calculate payouts
        uint256 winnerPrize = (round.prizePool * WINNER_SHARE_BPS) / BPS_BASE;
        uint256 toBurn = round.prizePool - winnerPrize;

        round.winner = winner;
        round.drawn = true;

        // PULL PATTERN
        pendingWinnings[winner] += winnerPrize;
        totalPaidOut += winnerPrize;

        // Burn 20% — send to dead address, permanently removing from supply
        if (toBurn > 0) {
            totalBurned += toBurn;
            (bool success, ) = payable(BURN_ADDRESS).call{value: toBurn}("");
            require(success, "Burn transfer failed");
        }

        emit RoundDrawn(currentRound, winner, winnerPrize, toBurn);
        
        // Start new round
        _startNewRound();
    }
    
    /**
     * @notice Start a new round manually (if draw is delayed)
     */
    function forceNewRound() external onlyOwner {
        Round storage round = rounds[currentRound];
        require(block.timestamp >= round.endTime, "Current round active");
        
        if (!round.drawn && round.totalTickets == 0) {
            // No tickets sold, just start new round
            _startNewRound();
        }
    }
    
    function _startNewRound() internal {
        currentRound++;
        Round storage newRound = rounds[currentRound];
        newRound.startTime = block.timestamp;
        newRound.endTime = block.timestamp + ROUND_DURATION;
        
        emit NewRoundStarted(currentRound, newRound.endTime);
    }
    
    // ═══════════════════════════════════════════════════════════════════════
    //                              WITHDRAWALS
    // ═══════════════════════════════════════════════════════════════════════
    
    function claimWinnings() external nonReentrant {
        uint256 amount = pendingWinnings[msg.sender];
        require(amount > 0, "No winnings");

        pendingWinnings[msg.sender] = 0;

        (bool success, ) = payable(msg.sender).call{value: amount}("");
        require(success, "Transfer failed");

        emit WinningsClaimed(msg.sender, amount);
    }

    /**
     * @notice Emergency refund if oracle never draws a round.
     *
     * If a round ends and the oracle fails to call drawWinner() within
     * REFUND_GRACE_PERIOD (7 days), ticket holders can reclaim their full cost.
     * This prevents funds being permanently stuck due to oracle outages.
     *
     * @param roundId The round to claim a refund for
     */
    function claimRefund(uint256 roundId) external nonReentrant {
        Round storage round = rounds[roundId];
        require(!round.drawn, "Round was drawn - no refund");
        require(
            block.timestamp >= round.endTime + REFUND_GRACE_PERIOD,
            "Grace period not elapsed"
        );
        require(!refundClaimed[msg.sender][roundId], "Already refunded");

        uint256 ticketCount = userTickets[msg.sender][roundId].length;
        require(ticketCount > 0, "No tickets in this round");

        refundClaimed[msg.sender][roundId] = true;

        uint256 refundAmount = ticketCount * TICKET_PRICE;
        require(address(this).balance >= refundAmount, "Insufficient contract balance");

        (bool success, ) = payable(msg.sender).call{value: refundAmount}("");
        require(success, "Refund transfer failed");

        emit EmergencyRefundClaimed(msg.sender, roundId, refundAmount);
    }

    // ═══════════════════════════════════════════════════════════════════════
    //                              VIEW FUNCTIONS
    // ═══════════════════════════════════════════════════════════════════════
    
    function getCurrentRoundInfo() external view returns (
        uint256 roundId,
        uint256 endTime,
        uint256 prizePool,
        uint256 totalTickets,
        uint256 timeRemaining
    ) {
        Round storage round = rounds[currentRound];
        roundId = currentRound;
        endTime = round.endTime;
        prizePool = round.prizePool;
        totalTickets = round.totalTickets;
        timeRemaining = block.timestamp < round.endTime ? round.endTime - block.timestamp : 0;
    }
    
    function getUserTickets(address user, uint256 roundId) external view returns (uint256[] memory) {
        return userTickets[user][roundId];
    }
    
    function getRoundWinner(uint256 roundId) external view returns (address winner, uint256 prize, bool drawn) {
        Round storage round = rounds[roundId];
        return (round.winner, (round.prizePool * WINNER_SHARE_BPS) / BPS_BASE, round.drawn);
    }
    
    // ═══════════════════════════════════════════════════════════════════════
    //                              INTERNAL
    // ═══════════════════════════════════════════════════════════════════════
    
    function _pseudoRandom(uint256 max) internal view returns (uint256) {
        // Simple pseudo-random - use Chainlink VRF for mainnet
        return uint256(keccak256(abi.encodePacked(
            block.timestamp,
            block.prevrandao,
            msg.sender,
            currentRound
        ))) % max;
    }
    
    // ═══════════════════════════════════════════════════════════════════════
    //                              ADMIN
    // ═══════════════════════════════════════════════════════════════════════
    
    function pause() external onlyOwner {
        _pause();
    }
    
    function unpause() external onlyOwner {
        _unpause();
    }
    
    receive() external payable {}
}
