// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

interface IERC165Like {
    function supportsInterface(bytes4 interfaceId) external view returns (bool);
}

interface IBurnRedeemableLike {
    function onTokenBurned(address user, uint256 amount) external;
}

/// @dev Test double reproducing XENCrypto.burn() semantics exactly:
///      require ERC165 IBurnRedeemable on caller, spend allowance, burn,
///      userBurns[user] += amount, callback onTokenBurned(user, amount).
contract MockXEN is ERC20 {
    mapping(address => uint256) public userBurns;

    constructor() ERC20("XEN Crypto", "XEN") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function burn(address user, uint256 amount) public {
        require(amount > 0, "XEN: amount");
        require(
            IERC165Like(msg.sender).supportsInterface(0x543746b1),
            "Burn: not a supported contract"
        );
        _spendAllowance(user, msg.sender, amount);
        _burn(user, amount);
        userBurns[user] += amount;
        IBurnRedeemableLike(msg.sender).onTokenBurned(user, amount);
    }
}
