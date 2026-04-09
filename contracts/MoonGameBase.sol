// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/security/Pausable.sol";

/**
 * MoonGameBase — Flywheel Base for all Moon Forge games.
 *
 * Fee policy (whitepaper v12.0):
 *   Game fees → 100% to Reward Pool (MoonForgeBase vault).
 *   Games do not pay the oracle or architect directly.
 *   Oracle gas costs are covered by the ejectPilot fee split in MoonForgeBase.
 *
 * SECURITY NOTE: _pseudoRandom() uses block.prevrandao + timestamp. This is
 * suitable for X1 testnet/beta. For mainnet, replace with Chainlink VRF or
 * an equivalent verifiable randomness source.
 */
contract MoonGameBase is Ownable, ReentrancyGuard, Pausable {
    address public immutable vaultContract; // The Main Reward Pool (MoonForgeBase)

    uint256 public constant BPS_BASE = 10000;

    event FundsToPool(uint256 amount);

    constructor(address _vault, address _oracle) {
        require(_vault != address(0), "Invalid vault");
        vaultContract = _vault;
        // _oracle param kept for ABI compatibility — not used for fee routing
        (_oracle); // silence unused warning
    }

    /**
     * @dev Send 100% of house fees to the reward vault.
     *      This is the flywheel: game activity continuously feeds the XNT pool
     *      that rewards XEN burners. The more games played, the higher the APY.
     */
    function _distributeFees(uint256 amount) internal {
        if (amount == 0) return;
        (bool ok, ) = payable(vaultContract).call{value: amount}("");
        require(ok, "Vault transfer failed");
        emit FundsToPool(amount);
    }

    /**
     * @dev Pseudo-random helper. NOT safe for high-value mainnet production.
     *      Replace with Chainlink VRF before significant liquidity deployment.
     */
    function _pseudoRandom(uint256 max) internal view virtual returns (uint256) {
        return uint256(keccak256(abi.encodePacked(
            block.timestamp,
            block.prevrandao,
            msg.sender,
            gasleft()
        ))) % max;
    }

    function pauseGame() external onlyOwner {
        _pause();
    }

    function unpauseGame() external onlyOwner {
        _unpause();
    }
}
