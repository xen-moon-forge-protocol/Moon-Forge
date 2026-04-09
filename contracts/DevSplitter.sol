// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *                            DEV SPLITTER v1.0
 *                    IMMUTABLE AUTO-DISTRIBUTION CONTRACT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Receives the 2% dev fee from MoonForgeBase penalties and automatically
 * distributes it proportionally to up to 3 recipient wallets.
 *
 * NO owner. NO admin. NO upgradability. Fully immutable after deploy.
 * All recipients and shares are hardcoded at construction — never changeable.
 *
 * Anyone can call distribute() — permissionless collection.
 * The deployer gains nothing special — just another wallet that receives fees.
 *
 * Deploy instructions:
 *   1. Set DEV_WALLET_0/1/2 and DEV_SHARE_0/1/2 in .env (shares must sum to 10000)
 *   2. Run: npx hardhat run scripts/deploy_final.ts --network <chain>
 *   3. Use DevSplitter.address as _devWallet in MoonForgeBase constructor (automated)
 *   4. Call distribute() anytime to collect accumulated fees to recipient wallets
 *
 * Note: Solidity immutable arrays are not supported — each recipient and share
 * is stored as a separate immutable variable for gas efficiency and true immutability.
 */
contract DevSplitter {

    uint256 private constant BPS_BASE = 10000;
    uint256 private constant MIN_DISTRIBUTE = 0.001 ether; // spam guard

    // ── Recipient wallets (immutable — set once at deploy, never changeable) ──
    address public immutable recipient0;
    address public immutable recipient1;
    address public immutable recipient2;

    // ── Shares in basis points (must sum to 10000) ────────────────────────────
    uint256 public immutable share0;
    uint256 public immutable share1;
    uint256 public immutable share2;

    event Distributed(uint256 total, uint256 amount0, uint256 amount1, uint256 amount2);
    event Received(address indexed from, uint256 amount);

    // ═══════════════════════════════════════════════════════════════════════
    //                           CONSTRUCTOR
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * @param _r0 First personal wallet address
     * @param _r1 Second personal wallet address
     * @param _r2 Third personal wallet address
     * @param _s0 BPS share for _r0 (e.g. 5000 = 50%)
     * @param _s1 BPS share for _r1 (e.g. 3000 = 30%)
     * @param _s2 BPS share for _r2 (e.g. 2000 = 20%)
     *            _s0 + _s1 + _s2 must equal 10000
     *
     * Example: (walletA, walletB, walletC, 5000, 3000, 2000)
     *          → 50% to walletA, 30% to walletB, 20% to walletC
     *
     * If you want only 1 wallet: use same address for all 3, shares (10000, 0, 0)
     * If you want 2 wallets:     set _r2 = _r1, share2 = 0 and split _s0 + _s1 = 10000
     */
    constructor(
        address _r0, address _r1, address _r2,
        uint256 _s0, uint256 _s1, uint256 _s2
    ) {
        require(_r0 != address(0) && _r1 != address(0) && _r2 != address(0), "Invalid recipient");
        require(_s0 + _s1 + _s2 == BPS_BASE, "Shares must sum to 10000");

        recipient0 = _r0;
        recipient1 = _r1;
        recipient2 = _r2;
        share0 = _s0;
        share1 = _s1;
        share2 = _s2;
    }

    // ═══════════════════════════════════════════════════════════════════════
    //                          DISTRIBUTION
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * @notice Distribute the full accumulated balance to all recipients.
     *         Permissionless — anyone can trigger this.
     *         Amounts are proportional to hardcoded shares.
     *         Recipient2 always gets the remainder to absorb rounding dust.
     */
    function distribute() external {
        uint256 balance = address(this).balance;
        require(balance >= MIN_DISTRIBUTE, "Balance too low");

        uint256 amt0 = (balance * share0) / BPS_BASE;
        uint256 amt1 = (balance * share1) / BPS_BASE;
        uint256 amt2 = balance - amt0 - amt1; // remainder — absorbs rounding dust

        if (amt0 > 0) {
            (bool ok0,) = payable(recipient0).call{value: amt0}("");
            require(ok0, "Transfer to recipient0 failed");
        }
        if (amt1 > 0) {
            (bool ok1,) = payable(recipient1).call{value: amt1}("");
            require(ok1, "Transfer to recipient1 failed");
        }
        if (amt2 > 0) {
            (bool ok2,) = payable(recipient2).call{value: amt2}("");
            require(ok2, "Transfer to recipient2 failed");
        }

        emit Distributed(balance, amt0, amt1, amt2);
    }

    /// @notice Pending balance available for distribution.
    function pendingBalance() external view returns (uint256) {
        return address(this).balance;
    }

    // ═══════════════════════════════════════════════════════════════════════
    //                         RECEIVE
    // ═══════════════════════════════════════════════════════════════════════

    receive() external payable {
        emit Received(msg.sender, msg.value);
    }
}
