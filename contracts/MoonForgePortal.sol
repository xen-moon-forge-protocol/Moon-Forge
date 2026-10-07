// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *                        MOON FORGE PORTAL v2 (EVM)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Burn XEN on this chain → receive XNT on X1.
 *
 * • Real burn: calls XEN.burn(msg.sender, amount) through XEN's official
 *   IBurnRedeemable flow. XEN totalSupply goes down and the burn is recorded in
 *   XEN's own immutable `userBurns` ledger (same mechanism XEN Prime uses).
 * • No owner, no admin, no fee, no pause, no upgrade, no trusted forwarder
 *   (the March 2026 DBXen exploit abused ERC-2771 + this callback; we never
 *   use _msgSender() indirection: burner == credited user == msg.sender).
 * • The X1 destination is a raw 32-byte Ed25519 public key (the bytes behind
 *   your Base58 X1 address), so EVM 0x addresses and typos cannot slip through.
 *
 * The off-chain oracle reads `MissionStarted`, waits for finality, and
 * publishes a Merkle root on X1 where the claim is permissionless.
 */

interface IBurnableToken {
    function burn(address user, uint256 amount) external;
}

/// Same interface as XEN's IBurnRedeemable (interfaceId 0x543746b1).
interface IBurnRedeemable {
    function onTokenBurned(address user, uint256 amount) external;
}

interface IERC165 {
    function supportsInterface(bytes4 interfaceId) external view returns (bool);
}

contract MoonForgePortal is IBurnRedeemable, IERC165 {
    /// XEN token on this chain. Immutable.
    address public immutable xen;

    uint256 public totalBurned;
    uint256 public totalMissions;

    // Single in-flight burn (also acts as a reentrancy lock).
    address private _pendingUser;
    uint256 private _pendingAmount;

    event MissionStarted(
        uint256 indexed missionId,
        address indexed pilot,
        uint256 amount,
        uint8 tier,
        bytes32 x1Pubkey,
        uint256 chainId,
        uint256 timestamp
    );

    error InvalidXen();
    error InvalidAmount();
    error InvalidTier();
    error InvalidX1Address();
    error Busy();
    error NotXen();
    error UnexpectedCallback();
    error CallbackMissing();

    constructor(address xen_) {
        if (xen_.code.length == 0) revert InvalidXen();
        xen = xen_;
    }

    /**
     * @notice Burn `amount` XEN (approve this contract first) and register an X1 mission.
     * @param amount   XEN amount in wei (18 decimals)
     * @param tier     0 = Launchpad (instant, 1x), 1 = Orbit (45d vesting, 2x), 2 = Moon Landing (180d, 3x)
     * @param x1Pubkey Your X1 wallet public key as 32 raw bytes (Base58-decoded). Never an 0x address.
     */
    function enterForge(uint256 amount, uint8 tier, bytes32 x1Pubkey) external {
        if (amount == 0) revert InvalidAmount();
        if (tier > 2) revert InvalidTier();
        if (x1Pubkey == bytes32(0)) revert InvalidX1Address();
        if (_pendingUser != address(0)) revert Busy();

        _pendingUser = msg.sender;
        _pendingAmount = amount;
        // XEN spends our allowance, burns from msg.sender, then calls onTokenBurned.
        IBurnableToken(xen).burn(msg.sender, amount);
        if (_pendingUser != address(0)) revert CallbackMissing();

        uint256 id;
        unchecked {
            id = ++totalMissions;
        }
        totalBurned += amount;
        emit MissionStarted(id, msg.sender, amount, tier, x1Pubkey, block.chainid, block.timestamp);
    }

    /// @dev Called by XEN during burn(). Only accepted for the burn this contract started.
    function onTokenBurned(address user, uint256 amount) external override {
        if (msg.sender != xen) revert NotXen();
        if (user == address(0) || user != _pendingUser || amount != _pendingAmount) revert UnexpectedCallback();
        _pendingUser = address(0);
        _pendingAmount = 0;
    }

    function supportsInterface(bytes4 interfaceId) external pure override returns (bool) {
        return interfaceId == type(IBurnRedeemable).interfaceId || interfaceId == type(IERC165).interfaceId;
    }

    function getStats() external view returns (uint256 burned, uint256 missions) {
        return (totalBurned, totalMissions);
    }
}
