// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *                           MOON TIME LOCK v7.1
 *                         THE TRANSPARENCY VAULT
 * ═══════════════════════════════════════════════════════════════════════════
 * 
 * 🔒 LOGIC:
 * - Receives XNT (from Architect's 50% share of fees)
 * - Releases 10% of Total Received every 30 days
 * - Funds go ONLY to the Architect (beneficiary)
 * - Public `release()` function (anyone can trigger, but destination is fixed)
 */
contract MoonTimeLock is Ownable {
    
    address public immutable beneficiary;
    uint256 public immutable startTime;
    
    uint256 public released;
    uint256 public constant VESTING_PERIOD = 30 days;
    uint256 public constant RELEASE_PER_PERIOD_BPS = 1000; // 10%
    uint256 public constant BPS_BASE = 10000;
    
    event Released(uint256 amount);
    
    constructor(address _beneficiary) Ownable() {
        require(_beneficiary != address(0), "Invalid beneficiary");
        beneficiary = _beneficiary;
        startTime = block.timestamp;
    }
    
    /**
     * @notice Releases vested tokens to the beneficiary.
     */
    function release() external {
        uint256 vestable = _vestedAmount();
        uint256 amount = vestable - released;
        require(amount > 0, "Nothing to release");
        
        released += amount;
        payable(beneficiary).transfer(amount);
        
        emit Released(amount);
    }
    
    /**
     * @notice Calculates the amount that has already vested.
     */
    function _vestedAmount() internal view returns (uint256) {
        uint256 totalBalance = address(this).balance + released;
        
        if (block.timestamp < startTime) {
            return 0;
        }
        
        uint256 periodsPassed = (block.timestamp - startTime) / VESTING_PERIOD;
        if (periodsPassed == 0) return 0;
        
        // 10% per period
        uint256 vestable = (totalBalance * periodsPassed * RELEASE_PER_PERIOD_BPS) / BPS_BASE;
        
        return vestable > totalBalance ? totalBalance : vestable;
    }
    
    function getVestingStatus() external view returns (
        uint256 totalReceived,
        uint256 alreadyReleased,
        uint256 availableToRelease,
        uint256 periodsPassed
    ) {
        uint256 total = address(this).balance + released;
        uint256 vestable = _vestedAmount();
        return (total, released, vestable - released, (block.timestamp - startTime) / VESTING_PERIOD);
    }
    
    receive() external payable {}
}
