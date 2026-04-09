// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";

interface IMoonForgeBase {
    function epochVolume(uint256 epoch) external view returns (uint256);
    function currentEpoch() external view returns (uint256);
    function donate() external payable;
}

/**
 * @title DevEscrow
 * @notice Trustless community incentive escrow for the 1.5% cycle bonus.
 *
 * ─────────────────────────────────────────────────────────────────
 *  Every CYCLE_LENGTH epochs (4 weeks) anyone can call settleCycle().
 *
 *  Goal metric: sum of epochVolume[] in MoonForgeBase for the last 4 epochs.
 *  epochVolume is written on-chain by users themselves via initializeMission().
 *  No oracle trust required — fully permissionless.
 *
 *  Settlement logic:
 *    Goal met  (cycleVol >= prevCycleVol × 95%):
 *      → 100% of cycle deposits  → reward pool (community bonus)
 *      → carry-over release      → reward pool (bonus from previous missed cycles)
 *
 *    Goal missed:
 *      → 2/3 of cycle deposits (~1.0%)  → DEV_WALLET
 *      → 1/3 of cycle deposits (~0.5%)  → carry-over, released over next 4 cycles
 *      → carry-over release (if any)    → reward pool
 *
 *  DEV_WALLET is hardcoded as a constant — forks that do not change the source
 *  bytecode will always route fees to the original creator.
 * ─────────────────────────────────────────────────────────────────
 */
contract DevEscrow is Ownable, ReentrancyGuard {

    // ═══════════════════════════════════════════════════════════════════════
    //                              CONSTANTS
    // ═══════════════════════════════════════════════════════════════════════

    // ─── TRANSPARENCY ───────────────────────────────────────────────────────
    // DEV_WALLET is a Solidity `constant` — baked permanently into this bytecode.
    // A fork that deploys without changing this address will always pay the original
    // creator. Verify against the published verified source on the explorer.
    //
    // HOW THE 1.5% WORKS (for users, referrers, and forks):
    //   This contract holds 1.5% of early-exit penalties for exactly 4 epochs (28 days).
    //   Anyone (not just the dev) can call settleCycle() to trigger distribution.
    //
    //   Goal = XNT allocated this cycle ≥ 95% of previous cycle (on-chain, no oracle).
    //   Goal met:    100% → Reward Pool. Dev gets nothing from escrow.
    //   Goal missed: ~1.0% (2/3) → Dev Wallet; ~0.5% (1/3) → carried to future pool.
    //
    //   The carry-over ALWAYS eventually reaches the pool — it is never destroyed.
    //   If the community grows the platform, the dev earns nothing from this contract.
    // ────────────────────────────────────────────────────────────────────────
        address public constant DEV_WALLET = 0x0000000000000000000000000000000000000000; // FILL BEFORE DEPLOY


    uint256 public constant CYCLE_LENGTH       = 4;    // epochs per cycle (4 × 7 days = 28 days)
    uint256 public constant GOAL_TOLERANCE_BPS = 500;  // 5% dip allowed before goal fails
    uint256 public constant CARRY_CYCLES       = 4;    // missed-goal carry-over spread over N cycles
    uint256 public constant BPS_BASE           = 10000;

    // ═══════════════════════════════════════════════════════════════════════
    //                              STATE
    // ═══════════════════════════════════════════════════════════════════════

    /// @dev Set once post-deploy via setVault(), then owner renounces.
    address public vault;

    uint256 public cycleNumber = 1;      // current 4-epoch cycle (1-indexed)
    uint256 public lastCycleVolume;      // XNT allocated in previous cycle

    // Current-cycle accounting (separate from carry-over)
    uint256 public cycleDeposits;        // 1.5% deposits received this cycle

    // Carry-over from missed goals
    uint256 public carryOverBalance;     // accumulated from previous missed cycles
    uint256 public carryOverCyclesLeft;  // how many cycles left to release carry-over

    // ═══════════════════════════════════════════════════════════════════════
    //                              EVENTS
    // ═══════════════════════════════════════════════════════════════════════

    event CycleSettled(
        uint256 indexed cycle,
        bool    goalMet,
        uint256 toPool,
        uint256 toDev,
        uint256 carryAdded,
        uint256 carryReleased,
        uint256 thisCycleVol,
        uint256 prevCycleVol
    );
    event VaultSet(address vault);
    event Deposited(uint256 indexed cycle, uint256 amount);

    // ═══════════════════════════════════════════════════════════════════════
    //                              SETUP
    // ═══════════════════════════════════════════════════════════════════════

    constructor() Ownable() {}

    /**
     * @notice Set the vault (MoonForgeBase) address — one-time, owner-only.
     *         Caller should renounceOwnership() immediately after to lock the
     *         DevEscrow permanently (zero admin surface).
     */
    function setVault(address _vault) external onlyOwner {
        require(vault == address(0), "Vault already set");
        require(_vault != address(0), "Invalid vault");
        vault = _vault;
        emit VaultSet(_vault);
    }

    // ═══════════════════════════════════════════════════════════════════════
    //                              CORE
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * @notice Called by MoonForgeBase.ejectPilot() for each penalty.
     *         msg.value = 1.5% of the penalty (ESCROW_SHARE_BPS).
     */
    function deposit() external payable {
        require(msg.sender == vault, "Only vault");
        cycleDeposits += msg.value;
        emit Deposited(cycleNumber, msg.value);
    }

    /**
     * @notice Settle the current cycle. Permissionless — anyone can call
     *         once all CYCLE_LENGTH epochs of the cycle have closed.
     *
     * Goal metric is read trustlessly from MoonForgeBase.epochVolume[].
     * Users write epochVolume via initializeMission() — no oracle involvement.
     */
    function settleCycle() external nonReentrant {
        require(vault != address(0), "Vault not set");

        IMoonForgeBase base = IMoonForgeBase(vault);
        uint256 epoch     = base.currentEpoch();
        uint256 cycleEnd  = cycleNumber * CYCLE_LENGTH;

        require(epoch > cycleEnd, "Cycle not complete yet");

        // ── 1. Measure this cycle's volume (on-chain, trustless) ──────────
        uint256 cycleStart   = (cycleNumber - 1) * CYCLE_LENGTH + 1;
        uint256 thisCycleVol = 0;
        for (uint256 i = cycleStart; i <= cycleEnd; i++) {
            thisCycleVol += base.epochVolume(i);
        }

        // ── 2. Evaluate goal ──────────────────────────────────────────────
        // First cycle always passes (bootstrap: prevVol == 0).
        bool goalMet = lastCycleVolume == 0 ||
            thisCycleVol * BPS_BASE >= lastCycleVolume * (BPS_BASE - GOAL_TOLERANCE_BPS);

        // ── 3. Calculate carry-over release for this cycle ────────────────
        uint256 carryRelease = 0;
        if (carryOverBalance > 0 && carryOverCyclesLeft > 0) {
            carryRelease = carryOverBalance / carryOverCyclesLeft;
            carryOverBalance    -= carryRelease;
            carryOverCyclesLeft -= 1;
        }

        // ── 4. Snapshot and reset cycle state ─────────────────────────────
        uint256 cycleDeposit = cycleDeposits;
        uint256 prevVol   = lastCycleVolume;
        uint256 settled   = cycleNumber;

        lastCycleVolume = thisCycleVol;
        cycleNumber++;
        cycleDeposits = 0;

        // ── 5. Distribute ─────────────────────────────────────────────────
        uint256 toPool  = 0;
        uint256 toDev   = 0;
        uint256 carryAdded = 0;

        if (goalMet) {
            // Goal met: 100% of cycle deposits → pool + carry release → pool
            toPool = cycleDeposit + carryRelease;
        } else {
            // Goal missed:
            //   2/3 of deposits (~1.0%) → dev wallet
            //   1/3 of deposits (~0.5%) → carry-over, spread over next CARRY_CYCLES
            //   carry release (from prior missed cycles) → pool
            toDev      = (cycleDeposit * 2) / 3;
            carryAdded = cycleDeposit - toDev;           // ~0.5%, remainder from integer division

            carryOverBalance += carryAdded;
            // Reset or extend carry-over window
            if (carryOverCyclesLeft == 0) {
                carryOverCyclesLeft = CARRY_CYCLES;
            }
            // Carry release from *previous* misses still goes to pool this cycle
            toPool = carryRelease;
        }

        // Transfers (after all state updates — reentrancy safe)
        if (toPool > 0) {
            base.donate{value: toPool}();
        }
        if (toDev > 0) {
            (bool ok, ) = payable(DEV_WALLET).call{value: toDev}("");
            require(ok, "Dev transfer failed");
        }

        emit CycleSettled(settled, goalMet, toPool, toDev, carryAdded, carryRelease, thisCycleVol, prevVol);
    }

    // ═══════════════════════════════════════════════════════════════════════
    //                              VIEW
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * @notice Returns current cycle progress for frontend display.
     * @return thisCycleVol   XNT allocated so far in current cycle (closed epochs only)
     * @return prevCycleVol   XNT allocated in previous cycle (the target baseline)
     * @return progressBps    Current vol as BPS of prevVol. Goal = 9500 (95%). 10000 = 100%.
     * @return onTrack        True if currently on pace to meet the goal
     * @return epochsRemaining Epochs remaining until cycle can be settled
     * @return pendingCarryOver Carry-over balance still queued for future pool releases
     */
    function getCycleProgress() external view returns (
        uint256 thisCycleVol,
        uint256 prevCycleVol,
        uint256 progressBps,
        bool    onTrack,
        uint256 epochsRemaining,
        uint256 pendingCarryOver
    ) {
        if (vault == address(0)) return (0, 0, 0, false, CYCLE_LENGTH, 0);

        IMoonForgeBase base    = IMoonForgeBase(vault);
        uint256 epoch          = base.currentEpoch();
        uint256 cycleStart     = (cycleNumber - 1) * CYCLE_LENGTH + 1;
        uint256 cycleEnd       = cycleNumber * CYCLE_LENGTH;

        uint256 countTo = epoch < cycleEnd ? epoch : cycleEnd;
        for (uint256 i = cycleStart; i <= countTo; i++) {
            thisCycleVol += base.epochVolume(i);
        }

        prevCycleVol    = lastCycleVolume;
        epochsRemaining = epoch < cycleEnd ? cycleEnd - epoch : 0;
        pendingCarryOver = carryOverBalance;

        if (prevCycleVol == 0) {
            progressBps = BPS_BASE;
            onTrack     = true;
        } else {
            progressBps = (thisCycleVol * BPS_BASE) / prevCycleVol;
            onTrack     = progressBps >= BPS_BASE - GOAL_TOLERANCE_BPS;
        }
    }

    receive() external payable {}
}
