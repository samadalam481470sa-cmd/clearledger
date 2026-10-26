// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @dev Adversarial test fixture only. This is not a production wallet or multisig.
contract ContractWallet {
    address public immutable owner;
    address public requiredCaller;
    bool public revoked;
    uint8 public mode;
    uint256 public mutations;
    mapping(bytes32 => bool) public approvedEmpty;
    bytes4 private constant MAGIC = 0x1626ba7e;

    constructor(address account) { owner = account; }
    modifier onlyOwner() { require(msg.sender == owner, "owner only"); _; }
    function setMode(uint8 value) external onlyOwner { mode = value; }
    function setRevoked(bool value) external onlyOwner { revoked = value; }
    function setRequiredCaller(address value) external onlyOwner { requiredCaller = value; }
    function approveEmpty(bytes32 digest, bool value) external onlyOwner { approvedEmpty[digest] = value; }
    function execute(address target, bytes calldata data) external onlyOwner returns (bytes memory) {
        (bool ok, bytes memory result) = target.call(data);
        require(ok, "execution failed");
        return result;
    }

    // Deliberately non-view so mode 5 can attempt an SSTORE. The router must use
    // STATICCALL and reject that validator without allowing its state to change.
    function isValidSignature(bytes32 digest, bytes calldata signature) external returns (bytes4) {
        if (revoked || (requiredCaller != address(0) && msg.sender != requiredCaller)) return 0xffffffff;
        if (mode == 1) return 0xffffffff;
        if (mode == 2) {
            assembly { mstore(0, shl(224, 0x1626ba7e)) return(0, 4) }
        }
        if (mode == 3) {
            assembly { mstore(0, or(shl(224, 0x1626ba7e), 1)) return(0, 32) }
        }
        if (mode == 4) revert("validator rejected");
        if (mode == 5) { mutations++; return MAGIC; }
        if (signature.length == 0 && approvedEmpty[digest]) return MAGIC;
        if (mode == 6) return 0xffffffff; // Only the approved empty signature is valid.
        (address recovered, ECDSA.RecoverError error,) = ECDSA.tryRecover(digest, signature);
        if (error != ECDSA.RecoverError.NoError || recovered != owner) return 0xffffffff;
        if (mode == 7) {
            assembly { mstore(0, shl(224, 0x1626ba7e)) mstore(32, 1) return(0, 64) }
        }
        return MAGIC;
    }
}
