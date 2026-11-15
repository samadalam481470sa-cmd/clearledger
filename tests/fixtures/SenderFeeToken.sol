// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @dev Test fixture. The recipient receives the full amount while the payer also funds a burn.
contract SenderFeeToken is ERC20 {
    uint256 private senderFee = 3;

    constructor(address payer, uint256 supply) ERC20("Sender Fee Test Token", "SFT") {
        _mint(payer, supply);
    }

    function disableFee() external {
        senderFee = 0;
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        if (from != address(0) && to != address(0) && senderFee != 0) {
            _burn(from, senderFee);
        }
    }
}
