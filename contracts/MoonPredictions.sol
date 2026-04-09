// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./MoonGameBase.sol";

/**
 * @title MoonPredictions
 * @notice Simple Yes/No prediction markets
 *
 * Example Markets:
 *   - "XEN price > $0.001 in 7 days?"
 *   - "Total XNT burned > 100k this week?"
 *
 * Mechanics:
 *   - Bet minimum 5 XNT
 *   - Market closes 24h before resolution
 *   - Oracle resolves outcome
 *   - Winners split pot (minus 2% to pool via MoonGameBase._distributeFees)
 */
contract MoonPredictions is MoonGameBase {

    // ═══════════════════════════════════════════════════════════════════════
    //                              TYPES
    // ═══════════════════════════════════════════════════════════════════════

    enum MarketStatus { OPEN, CLOSED, RESOLVED }
    enum Outcome { UNDECIDED, YES, NO }

    struct Market {
        string question;
        uint256 endTime;        // When betting closes
        uint256 resolveTime;    // When outcome is decided
        MarketStatus status;
        Outcome outcome;

        uint256 yesPool;
        uint256 noPool;
        uint256 yesCount;
        uint256 noCount;

        mapping(address => uint256) yesBets;
        mapping(address => uint256) noBets;
        mapping(address => bool) claimed;
    }

    // ═══════════════════════════════════════════════════════════════════════
    //                              CONSTANTS
    // ═══════════════════════════════════════════════════════════════════════

    uint256 public constant MIN_BET = 5 ether;          // 5 XNT minimum
    uint256 public constant POOL_FEE_BPS = 200;         // 2% to pool (flywheel)

    // ═══════════════════════════════════════════════════════════════════════
    //                              STATE
    // ═══════════════════════════════════════════════════════════════════════

    /// @dev Address allowed to resolve markets (separate from vault oracle). Immutable after deploy.
    address public immutable resolverOracle;

    uint256 public marketCount;
    mapping(uint256 => Market) public markets;

    uint256 public totalVolume;
    uint256 public totalMarkets;

    // ═══════════════════════════════════════════════════════════════════════
    //                              EVENTS
    // ═══════════════════════════════════════════════════════════════════════

    event MarketCreated(uint256 indexed marketId, string question, uint256 endTime, uint256 resolveTime);
    event BetPlaced(uint256 indexed marketId, address indexed bettor, bool isYes, uint256 amount);
    event MarketResolved(uint256 indexed marketId, Outcome outcome);
    event WinningsClaimed(uint256 indexed marketId, address indexed winner, uint256 amount);

    // ═══════════════════════════════════════════════════════════════════════
    //                              CONSTRUCTOR
    // ═══════════════════════════════════════════════════════════════════════

    constructor(address _vault, address _resolverOracle) MoonGameBase(_vault, address(0)) {
        resolverOracle = _resolverOracle;
    }

    // ═══════════════════════════════════════════════════════════════════════
    //                              CREATE MARKET
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * @notice Create a new prediction market (admin only)
     */
    function createMarket(
        string calldata question,
        uint256 endTime,
        uint256 resolveTime
    ) external onlyOwner {
        require(endTime > block.timestamp, "End must be future");
        require(resolveTime > endTime, "Resolve > end");

        marketCount++;
        Market storage m = markets[marketCount];
        m.question = question;
        m.endTime = endTime;
        m.resolveTime = resolveTime;
        m.status = MarketStatus.OPEN;
        m.outcome = Outcome.UNDECIDED;

        totalMarkets++;

        emit MarketCreated(marketCount, question, endTime, resolveTime);
    }

    // ═══════════════════════════════════════════════════════════════════════
    //                              BET
    // ═══════════════════════════════════════════════════════════════════════

    function bet(uint256 marketId, bool betYes) external payable nonReentrant whenNotPaused {
        require(msg.value >= MIN_BET, "Min 5 XNT");

        Market storage m = markets[marketId];
        require(m.status == MarketStatus.OPEN, "Not open");
        require(block.timestamp < m.endTime, "Betting closed");

        if (betYes) {
            m.yesPool += msg.value;
            m.yesBets[msg.sender] += msg.value;
            if (m.yesBets[msg.sender] == msg.value) m.yesCount++;
        } else {
            m.noPool += msg.value;
            m.noBets[msg.sender] += msg.value;
            if (m.noBets[msg.sender] == msg.value) m.noCount++;
        }

        totalVolume += msg.value;

        emit BetPlaced(marketId, msg.sender, betYes, msg.value);
    }

    // ═══════════════════════════════════════════════════════════════════════
    //                              RESOLVE
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * @notice Resolve a market (resolver oracle or owner)
     */
    function resolve(uint256 marketId, Outcome outcome) external {
        require(msg.sender == resolverOracle, "Only resolver oracle");
        require(outcome != Outcome.UNDECIDED, "Invalid outcome");

        Market storage m = markets[marketId];
        require(m.status == MarketStatus.OPEN || m.status == MarketStatus.CLOSED, "Already resolved");
        require(block.timestamp >= m.resolveTime, "Too early");

        m.status = MarketStatus.RESOLVED;
        m.outcome = outcome;

        // Send 2% of total pot to vault (flywheel) via MoonGameBase
        uint256 totalPot = m.yesPool + m.noPool;
        uint256 fee = (totalPot * POOL_FEE_BPS) / BPS_BASE;
        if (fee > 0) {
            _distributeFees(fee);
        }

        emit MarketResolved(marketId, outcome);
    }

    // ═══════════════════════════════════════════════════════════════════════
    //                              CLAIM
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * @notice Claim winnings from a resolved market
     */
    function claim(uint256 marketId) external nonReentrant {
        Market storage m = markets[marketId];
        require(m.status == MarketStatus.RESOLVED, "Not resolved");
        require(!m.claimed[msg.sender], "Already claimed");

        uint256 userBet;
        uint256 winningPool;
        uint256 losingPool;

        if (m.outcome == Outcome.YES) {
            userBet = m.yesBets[msg.sender];
            winningPool = m.yesPool;
            losingPool = m.noPool;
        } else {
            userBet = m.noBets[msg.sender];
            winningPool = m.noPool;
            losingPool = m.yesPool;
        }

        require(userBet > 0, "No winning bet");

        m.claimed[msg.sender] = true;

        // User's share = (userBet / winningPool) × (totalPot - fee)
        uint256 totalPot = winningPool + losingPool;
        uint256 fee = (totalPot * POOL_FEE_BPS) / BPS_BASE;
        uint256 distributablePot = totalPot - fee;
        uint256 winnings = (userBet * distributablePot) / winningPool;

        (bool ok, ) = payable(msg.sender).call{value: winnings}("");
        require(ok, "Claim transfer failed");

        emit WinningsClaimed(marketId, msg.sender, winnings);
    }

    // ═══════════════════════════════════════════════════════════════════════
    //                              VIEW
    // ═══════════════════════════════════════════════════════════════════════

    function getMarketInfo(uint256 marketId) external view returns (
        string memory question,
        uint256 endTime,
        uint256 resolveTime,
        MarketStatus status,
        Outcome outcome,
        uint256 yesPool,
        uint256 noPool
    ) {
        Market storage m = markets[marketId];
        return (m.question, m.endTime, m.resolveTime, m.status, m.outcome, m.yesPool, m.noPool);
    }

    function getUserBets(uint256 marketId, address user) external view returns (uint256 yesBet, uint256 noBet) {
        Market storage m = markets[marketId];
        return (m.yesBets[user], m.noBets[user]);
    }

    function getOdds(uint256 marketId) external view returns (uint256 yesOddsBps, uint256 noOddsBps) {
        Market storage m = markets[marketId];
        uint256 total = m.yesPool + m.noPool;
        if (total == 0) return (5000, 5000);

        yesOddsBps = (m.yesPool * BPS_BASE) / total;
        noOddsBps = BPS_BASE - yesOddsBps;
    }

    // ═══════════════════════════════════════════════════════════════════════
    //                              ADMIN
    // ═══════════════════════════════════════════════════════════════════════

    function closeMarket(uint256 marketId) external onlyOwner {
        Market storage m = markets[marketId];
        require(m.status == MarketStatus.OPEN, "Not open");
        m.status = MarketStatus.CLOSED;
    }

    receive() external payable {}
}
