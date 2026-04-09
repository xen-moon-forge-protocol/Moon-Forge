// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./MoonGameBase.sol";

/**
 * @title ArtifactDuel
 * @notice Rock-Paper-Scissors duel using Moon Forge NFT elements
 *
 * Element Cycle:
 *   Lunar Dust  → beats → Cosmic Shard  (dust absorbs crystal)
 *   Cosmic Shard → beats → Solar Core   (crystal reflects heat)
 *   Solar Core  → beats → Void Anomaly  (fire fills void)
 *   Void Anomaly → beats → Lunar Dust   (void consumes matter)
 *
 * Mechanics:
 *   - Bet: 2 XNT per duel
 *   - Best of 1, commit-reveal for player1 (prevents front-running)
 *   - Tie = both lose (all to reward vault)
 *   - Winner gets 97.5% of pot, 2.5% to XNT Reward Vault (flywheel)
 *
 * NFT Integration (optional):
 *   - Players may stake a MoonArtifacts NFT matching their chosen element
 *   - Winner with matching NFT gets a bonus from the pool share (based on NFT boostBps)
 *   - NFTs are ALWAYS returned to their owners after the duel resolves
 *   - Player1's NFT tier is validated at reveal time (commitment kept hidden until then)
 *   - Player2's NFT tier is validated at join time (element revealed immediately)
 *   - If no artifacts contract is set, duels work purely as XNT bets (no NFT features)
 *
 * Commit-Reveal Replay Protection:
 *   - Each commitment hash can only be used once (usedCommitments mapping)
 *   - Players MUST generate a new random secret for each duel
 *   - Use generateCommitment(element, secret) off-chain before calling createDuel()
 *
 * NFT Element ↔ Tier mapping (identical enum indices):
 *   Element.LUNAR_DUST  = ArtifactTier.LUNAR_DUST  = 0 (+5%  boost)
 *   Element.COSMIC_SHARD = ArtifactTier.COSMIC_SHARD = 1 (+10% boost)
 *   Element.SOLAR_CORE  = ArtifactTier.SOLAR_CORE  = 2 (+20% boost)
 *   Element.VOID_ANOMALY = ArtifactTier.VOID_ANOMALY = 3 (+50% boost)
 */

// ─── Interface ───────────────────────────────────────────────────────────────

interface IMoonArtifacts {
    /// @dev Returns (tier as uint8, boostBps, equipped, variantId)
    /// tier: 0=LUNAR_DUST, 1=COSMIC_SHARD, 2=SOLAR_CORE, 3=VOID_ANOMALY
    function artifacts(uint256 tokenId) external view returns (
        uint8 tier,
        uint256 boostBps,
        bool equipped,
        uint8 variantId
    );
    function ownerOf(uint256 tokenId) external view returns (address);
    function transferFrom(address from, address to, uint256 tokenId) external;
}

// ─── Contract ────────────────────────────────────────────────────────────────

contract ArtifactDuel is MoonGameBase {

    // ═══════════════════════════════════════════════════════════════════════
    //                              TYPES
    // ═══════════════════════════════════════════════════════════════════════

    enum Element { LUNAR_DUST, COSMIC_SHARD, SOLAR_CORE, VOID_ANOMALY }
    enum DuelStatus { OPEN, MATCHED, FINISHED }

    struct Duel {
        address player1;
        bytes32 player1Commit;   // keccak256(abi.encodePacked(element, secret))
        Element player1Element;
        bool    player1Revealed;
        uint256 p1TokenId;       // MoonArtifacts NFT staked by player1 (0 = none)
        bool    p1NftMatches;    // true if p1 NFT tier matches revealed element

        address player2;
        Element player2Element;
        uint256 p2TokenId;       // MoonArtifacts NFT staked by player2 (0 = none, tier already validated)

        uint256 bet;
        DuelStatus status;
        address winner;
        uint256 createdAt;
        uint256 matchedAt;       // When player2 joined — timeout counts from here
    }

    // ═══════════════════════════════════════════════════════════════════════
    //                              CONSTANTS
    // ═══════════════════════════════════════════════════════════════════════

    uint256 public constant DUEL_BET         = 2 ether;   // 2 XNT per duel
    uint256 public constant WINNER_SHARE_BPS = 9750;      // 97.5% to winner
    uint256 public constant POOL_SHARE_BPS   = 250;       // 2.5%  to reward vault (flywheel)
    uint256 public constant REVEAL_TIMEOUT   = 5 minutes; // player1 must reveal within this window
    uint256 public constant MAX_NFT_BOOST    = 5000;      // cap: max 50% of pool fee redirected to winner
    // BPS_BASE = 10000 inherited from MoonGameBase

    // ═══════════════════════════════════════════════════════════════════════
    //                              STATE
    // ═══════════════════════════════════════════════════════════════════════

    /// @notice MoonArtifacts contract address. address(0) = NFT features disabled.
    address public immutable artifactsContract;

    /// @notice Prevents commitment replay across duels (each secret must be unique)
    mapping(bytes32 => bool) public usedCommitments;

    // PULL PATTERN
    mapping(address => uint256) public pendingWinnings;

    uint256 public duelCount;
    mapping(uint256 => Duel) public duels;
    uint256[] public openDuels; // List of duel IDs waiting for opponent

    // Stats
    uint256 public totalDuels;
    uint256 public totalVolume;
    uint256 public totalPaidOut;

    // ═══════════════════════════════════════════════════════════════════════
    //                              EVENTS
    // ═══════════════════════════════════════════════════════════════════════

    event DuelCreated(uint256 indexed duelId, address indexed player1, uint256 nftTokenId);
    event DuelMatched(uint256 indexed duelId, address indexed player2, Element element, uint256 nftTokenId);
    event DuelRevealed(uint256 indexed duelId, address indexed player1, Element element, bool nftMatched);
    event DuelFinished(uint256 indexed duelId, address winner, uint256 prize, uint256 nftBonus);
    event DuelCancelled(uint256 indexed duelId, address indexed player1);
    event WinningsClaimed(address indexed player, uint256 amount);

    // ═══════════════════════════════════════════════════════════════════════
    //                              CONSTRUCTOR
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * @param _vault           XNT Reward Vault address (pool flywheel)
     * @param _oracle          Oracle address (pause/unpause only)
     * @param _artifactsContract MoonArtifacts NFT contract address
     *                         Pass address(0) to disable NFT features
     */
    constructor(
        address _vault,
        address _oracle,
        address _artifactsContract
    ) MoonGameBase(_vault, _oracle) {
        artifactsContract = _artifactsContract;
    }

    // ═══════════════════════════════════════════════════════════════════════
    //                              GAME FLOW
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * @notice Create a duel with a hidden element commitment.
     *
     * @param commitment  keccak256(abi.encodePacked(element, secret))
     *                    Use generateCommitment() off-chain. Secret must be unique per duel.
     * @param nftTokenId  Optional MoonArtifacts NFT to stake (0 = no NFT).
     *                    The NFT can be any tier — matching is validated at reveal.
     *                    Requires prior approval: MoonArtifacts.approve(thisContract, tokenId)
     *
     * @dev The commitment is registered in usedCommitments immediately.
     *      Reusing the same commitment in another duel will revert.
     */
    function createDuel(bytes32 commitment, uint256 nftTokenId)
        external payable nonReentrant whenNotPaused
    {
        require(msg.value >= DUEL_BET, "Bet is 2 XNT");
        require(!usedCommitments[commitment], "Commitment already used");

        usedCommitments[commitment] = true;

        duelCount++;
        Duel storage duel = duels[duelCount];
        duel.player1   = msg.sender;
        duel.player1Commit = commitment;
        duel.bet       = DUEL_BET;
        duel.status    = DuelStatus.OPEN;
        duel.createdAt = block.timestamp;

        // Optional NFT escrow — tier validated at reveal time
        if (nftTokenId != 0) {
            require(artifactsContract != address(0), "NFT features not enabled");
            require(
                IMoonArtifacts(artifactsContract).ownerOf(nftTokenId) == msg.sender,
                "Not NFT owner"
            );
            IMoonArtifacts(artifactsContract).transferFrom(msg.sender, address(this), nftTokenId);
            duel.p1TokenId = nftTokenId;
        }

        openDuels.push(duelCount);

        if (msg.value > DUEL_BET) {
            (bool ok, ) = payable(msg.sender).call{value: msg.value - DUEL_BET}("");
            require(ok, "Refund failed");
        }

        emit DuelCreated(duelCount, msg.sender, nftTokenId);
    }

    /**
     * @notice Cancel an open duel (player1 only, before any opponent joins).
     *         Refunds bet and returns staked NFT.
     */
    function cancelDuel(uint256 duelId) external nonReentrant {
        Duel storage duel = duels[duelId];
        require(duel.status == DuelStatus.OPEN, "Not open");
        require(duel.player1 == msg.sender, "Not player1");

        duel.status = DuelStatus.FINISHED;
        _removeFromOpenDuels(duelId);

        // Return staked NFT
        if (duel.p1TokenId != 0 && artifactsContract != address(0)) {
            IMoonArtifacts(artifactsContract).transferFrom(address(this), duel.player1, duel.p1TokenId);
        }

        // Refund bet
        (bool ok, ) = payable(msg.sender).call{value: duel.bet}("");
        require(ok, "Refund failed");

        emit DuelCancelled(duelId, msg.sender);
    }

    /**
     * @notice Join an open duel, reveal your element immediately.
     *
     * @param duelId     The duel to join
     * @param element    Your element choice (revealed immediately for player2)
     * @param nftTokenId Optional MoonArtifacts NFT matching your element (0 = no NFT).
     *                   NFT tier MUST match chosen element. Reverts if tier mismatches.
     */
    function joinDuel(uint256 duelId, Element element, uint256 nftTokenId)
        external payable nonReentrant whenNotPaused
    {
        require(msg.value >= DUEL_BET, "Bet is 2 XNT");

        Duel storage duel = duels[duelId];
        require(duel.status == DuelStatus.OPEN, "Not open");
        require(duel.player1 != msg.sender, "Can't fight yourself");

        duel.player2        = msg.sender;
        duel.player2Element = element;
        duel.status         = DuelStatus.MATCHED;
        duel.matchedAt      = block.timestamp;

        // Optional NFT escrow — tier must match chosen element
        if (nftTokenId != 0) {
            require(artifactsContract != address(0), "NFT features not enabled");
            require(
                IMoonArtifacts(artifactsContract).ownerOf(nftTokenId) == msg.sender,
                "Not NFT owner"
            );
            (uint8 tier,,,) = IMoonArtifacts(artifactsContract).artifacts(nftTokenId);
            require(tier == uint8(element), "NFT tier must match element");
            IMoonArtifacts(artifactsContract).transferFrom(msg.sender, address(this), nftTokenId);
            duel.p2TokenId = nftTokenId;
        }

        _removeFromOpenDuels(duelId);
        totalVolume += DUEL_BET * 2;

        if (msg.value > DUEL_BET) {
            (bool ok, ) = payable(msg.sender).call{value: msg.value - DUEL_BET}("");
            require(ok, "Refund failed");
        }

        emit DuelMatched(duelId, msg.sender, element, nftTokenId);
    }

    /**
     * @notice Reveal your element (player1 only). Resolves the duel immediately.
     *
     * @param duelId  The duel ID
     * @param element Your element (must match committed hash)
     * @param secret  The secret used when generating the commitment
     *
     * @dev If player1 staked an NFT but it doesn't match the revealed element,
     *      the NFT is still returned but no boost is applied.
     */
    function reveal(uint256 duelId, Element element, bytes32 secret)
        external nonReentrant whenNotPaused
    {
        Duel storage duel = duels[duelId];
        require(duel.status == DuelStatus.MATCHED, "Not matched");
        require(duel.player1 == msg.sender, "Not player1");
        require(!duel.player1Revealed, "Already revealed");

        // Verify commitment
        bytes32 expectedCommit = keccak256(abi.encodePacked(element, secret));
        require(expectedCommit == duel.player1Commit, "Invalid reveal");

        duel.player1Element  = element;
        duel.player1Revealed = true;

        // Validate p1's NFT matches revealed element (if staked)
        if (duel.p1TokenId != 0) {
            (uint8 tier,,,) = IMoonArtifacts(artifactsContract).artifacts(duel.p1TokenId);
            duel.p1NftMatches = (tier == uint8(element));
        }

        emit DuelRevealed(duelId, msg.sender, element, duel.p1NftMatches);

        _resolveDuel(duelId);
    }

    /**
     * @notice Player2 claims a win if player1 fails to reveal in time.
     *         Timeout begins from when player2 joined (matchedAt).
     */
    function claimTimeout(uint256 duelId) external nonReentrant {
        Duel storage duel = duels[duelId];
        require(duel.status == DuelStatus.MATCHED, "Not matched");
        require(!duel.player1Revealed, "Already revealed");
        require(block.timestamp >= duel.matchedAt + REVEAL_TIMEOUT, "Timeout not reached");

        duel.status = DuelStatus.FINISHED;
        duel.winner = duel.player2;

        // Return both NFTs to their owners (p1 forfeits the duel, not the NFT)
        _returnNFTs(duel);

        uint256 totalPot = duel.bet * 2;
        uint256 prize    = (totalPot * WINNER_SHARE_BPS) / BPS_BASE;
        uint256 toPool   = totalPot - prize;

        pendingWinnings[duel.player2] += prize;
        totalPaidOut += prize;

        if (toPool > 0) _distributeFees(toPool);

        totalDuels++;
        emit DuelFinished(duelId, duel.player2, prize, 0);
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
    //                              RESOLUTION
    // ═══════════════════════════════════════════════════════════════════════

    function _resolveDuel(uint256 duelId) internal {
        Duel storage duel = duels[duelId];

        Element e1 = duel.player1Element;
        Element e2 = duel.player2Element;

        address winner;
        if (e1 == e2) {
            winner = address(0); // Tie
        } else if (_beats(e1, e2)) {
            winner = duel.player1;
        } else {
            winner = duel.player2;
        }

        duel.status = DuelStatus.FINISHED;
        duel.winner = winner;

        // Always return NFTs to their original owners
        _returnNFTs(duel);

        uint256 totalPot = duel.bet * 2;

        if (winner == address(0)) {
            // Tie — all goes to XNT Reward Vault
            _distributeFees(totalPot);
            emit DuelFinished(duelId, address(0), 0, 0);
        } else {
            uint256 prize  = (totalPot * WINNER_SHARE_BPS) / BPS_BASE;
            uint256 toPool = totalPot - prize;

            // NFT Boost: winner with matching NFT gets a portion of the pool fee
            uint256 nftBonus = _calculateNFTBonus(duel, winner, toPool);
            if (nftBonus > 0) {
                prize  += nftBonus;
                toPool -= nftBonus;
            }

            pendingWinnings[winner] += prize;
            totalPaidOut += prize;

            if (toPool > 0) _distributeFees(toPool);

            emit DuelFinished(duelId, winner, prize, nftBonus);
        }

        totalDuels++;
    }

    /**
     * @dev Calculate NFT bonus for the winner.
     *      If winner staked a matching-tier NFT:
     *        bonus = (poolShare * nftBoostBps) / BPS_BASE
     *        capped at MAX_NFT_BOOST (50%) of pool share
     *      The remainder of pool share still goes to vault.
     */
    function _calculateNFTBonus(
        Duel storage duel,
        address winner,
        uint256 toPool
    ) internal view returns (uint256) {
        if (artifactsContract == address(0) || toPool == 0) return 0;

        bool hasMatchingNft;
        uint256 winnerTokenId;

        if (winner == duel.player1) {
            hasMatchingNft = duel.p1TokenId != 0 && duel.p1NftMatches;
            winnerTokenId  = duel.p1TokenId;
        } else {
            // player2's NFT tier was validated at join — always matches
            hasMatchingNft = duel.p2TokenId != 0;
            winnerTokenId  = duel.p2TokenId;
        }

        if (!hasMatchingNft) return 0;

        (, uint256 boostBps,,) = IMoonArtifacts(artifactsContract).artifacts(winnerTokenId);

        // Cap boost at MAX_NFT_BOOST to ensure vault always gets at least 50% of pool share
        uint256 capBps = boostBps > MAX_NFT_BOOST ? MAX_NFT_BOOST : boostBps;
        return (toPool * capBps) / BPS_BASE;
    }

    /**
     * @dev Return NFTs to their original owners after duel resolution.
     *      Called for all outcomes (win, lose, tie, timeout).
     */
    function _returnNFTs(Duel storage duel) internal {
        if (artifactsContract == address(0)) return;
        if (duel.p1TokenId != 0) {
            IMoonArtifacts(artifactsContract).transferFrom(address(this), duel.player1, duel.p1TokenId);
        }
        if (duel.p2TokenId != 0) {
            IMoonArtifacts(artifactsContract).transferFrom(address(this), duel.player2, duel.p2TokenId);
        }
    }

    /**
     * @dev Element cycle: LD beats CS, CS beats SC, SC beats VA, VA beats LD
     */
    function _beats(Element a, Element b) internal pure returns (bool) {
        if (a == Element.LUNAR_DUST   && b == Element.COSMIC_SHARD) return true;
        if (a == Element.COSMIC_SHARD && b == Element.SOLAR_CORE)   return true;
        if (a == Element.SOLAR_CORE   && b == Element.VOID_ANOMALY) return true;
        if (a == Element.VOID_ANOMALY && b == Element.LUNAR_DUST)   return true;
        return false;
    }

    function _removeFromOpenDuels(uint256 duelId) internal {
        for (uint256 i = 0; i < openDuels.length; i++) {
            if (openDuels[i] == duelId) {
                openDuels[i] = openDuels[openDuels.length - 1];
                openDuels.pop();
                break;
            }
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    //                              VIEW
    // ═══════════════════════════════════════════════════════════════════════

    function getOpenDuels() external view returns (uint256[] memory) {
        return openDuels;
    }

    function getDuelInfo(uint256 duelId) external view returns (
        address player1,
        address player2,
        uint256 bet,
        DuelStatus status,
        address winner,
        bool p1Revealed,
        uint256 p1TokenId,
        uint256 p2TokenId
    ) {
        Duel storage d = duels[duelId];
        return (d.player1, d.player2, d.bet, d.status, d.winner, d.player1Revealed, d.p1TokenId, d.p2TokenId);
    }

    /**
     * @notice Generate commitment for creating a duel (off-chain helper).
     *         Generate a cryptographically random secret (32 bytes) for each duel.
     *         NEVER reuse the same secret.
     */
    function generateCommitment(Element element, bytes32 secret)
        external pure returns (bytes32)
    {
        return keccak256(abi.encodePacked(element, secret));
    }

    /**
     * @notice Preview NFT boost for a given NFT token and pool amount.
     *         Useful for frontend display before joining.
     */
    function previewNFTBonus(uint256 tokenId, uint256 poolAmount)
        external view returns (uint256 bonus, uint256 boostBps)
    {
        if (artifactsContract == address(0) || tokenId == 0) return (0, 0);
        (, boostBps,,) = IMoonArtifacts(artifactsContract).artifacts(tokenId);
        uint256 capBps = boostBps > MAX_NFT_BOOST ? MAX_NFT_BOOST : boostBps;
        bonus = (poolAmount * capBps) / BPS_BASE;
    }

    // ═══════════════════════════════════════════════════════════════════════
    //                              ADMIN
    // ═══════════════════════════════════════════════════════════════════════

    // MoonGameBase provides: pauseGame(), unpauseGame()

    /**
     * @dev Reject direct NFT transfers (safeTransferFrom) to prevent accidental locks.
     *      Players must use createDuel() or joinDuel() to stake NFTs.
     */
    function onERC721Received(address, address, uint256, bytes calldata)
        external pure returns (bytes4)
    {
        revert("Use createDuel or joinDuel to stake NFTs");
    }

    receive() external payable {}
}
