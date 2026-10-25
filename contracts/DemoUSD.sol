// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";

/// @notice Test currency only: no reserves, redemption, or claim to real dollars.
/// @dev Allowlisting is an application control, not KYC or regulatory compliance.
contract DemoUSD is ERC20, AccessControl, Pausable {
    bytes32 public constant ISSUER_ROLE = keccak256("ISSUER_ROLE");
    bytes32 public constant POLICY_ROLE = keccak256("POLICY_ROLE");
    mapping(address => bool) public allowed;
    uint256 public immutable supplyCap;

    error RestrictedAccount(address account);
    error SupplyCapExceeded();
    event EligibilityChanged(address indexed account, bool eligible);

    constructor(address admin, uint256 cap) ERC20("ClearLedger Demo USD", "dUSD") {
        require(admin != address(0) && cap > 0, "invalid configuration");
        supplyCap = cap;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(ISSUER_ROLE, admin);
        _grantRole(POLICY_ROLE, admin);
    }

    function decimals() public pure override returns (uint8) { return 6; }

    function setAllowed(address account, bool eligible) external onlyRole(POLICY_ROLE) {
        require(account != address(0), "zero account");
        allowed[account] = eligible;
        emit EligibilityChanged(account, eligible);
    }

    function mint(address to, uint256 amount) external onlyRole(ISSUER_ROLE) {
        if (totalSupply() + amount > supplyCap) revert SupplyCapExceeded();
        _mint(to, amount);
    }

    function burn(uint256 amount) external { _burn(msg.sender, amount); }
    function pause() external onlyRole(POLICY_ROLE) { _pause(); }
    function unpause() external onlyRole(POLICY_ROLE) { _unpause(); }

    function _update(address from, address to, uint256 amount) internal override whenNotPaused {
        if (from != address(0) && !allowed[from]) revert RestrictedAccount(from);
        if (to != address(0) && !allowed[to]) revert RestrictedAccount(to);
        super._update(from, to, amount);
    }
}

