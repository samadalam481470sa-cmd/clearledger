// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/interfaces/IERC1271.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @notice Payer-authorized, noncustodial settlement for approved demo assets.
/// @dev Use standard non-rebasing, non-fee-on-transfer ERC20 assets only.
contract SettlementRouter is AccessControl, Pausable, ReentrancyGuard, EIP712 {
    using SafeERC20 for IERC20;
    bytes32 public constant SETTLER_ROLE = keccak256("SETTLER_ROLE");
    bytes32 public constant POLICY_ROLE = keccak256("POLICY_ROLE");
    bytes32 public constant PAYMENT_TYPEHASH = keccak256(
        "Payment(bytes32 paymentId,address payer,address payee,address token,uint256 amount,uint256 nonce,uint256 deadline)"
    );

    struct Payment {
        bytes32 paymentId;
        address payer;
        address payee;
        address token;
        uint256 amount;
        uint256 nonce;
        uint256 deadline;
    }
    struct Policy { uint256 perPayment; uint256 perDay; }
    mapping(address => Policy) public policies;
    mapping(address => uint256) public nonces;
    mapping(address => mapping(bytes32 => bool)) public processed;
    mapping(address => mapping(address => mapping(uint256 => uint256))) public dailySpent;

    error InvalidPayment();
    error Expired();
    error InvalidNonce();
    error AlreadyProcessed();
    error InvalidSignature();
    error LimitExceeded();
    error UnexpectedTransferAmount();

    event PaymentSettled(bytes32 indexed paymentId, address indexed payer,
        address indexed payee, address token, uint256 amount, uint256 nonce);
    event PolicyChanged(address indexed token, uint256 perPayment, uint256 perDay);
    event NonceInvalidated(address indexed payer, uint256 newNonce);

    constructor(address admin, address relayer) EIP712("ClearLedger", "1") {
        require(admin != address(0) && relayer != address(0), "zero role holder");
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(POLICY_ROLE, admin);
        _grantRole(SETTLER_ROLE, relayer);
    }

    function setPolicy(address token, uint256 perPayment, uint256 perDay)
        external onlyRole(POLICY_ROLE)
    {
        require(token.code.length > 0 && perDay >= perPayment, "invalid policy");
        policies[token] = Policy(perPayment, perDay);
        emit PolicyChanged(token, perPayment, perDay);
    }

    function pause() external onlyRole(POLICY_ROLE) { _pause(); }
    function unpause() external onlyRole(POLICY_ROLE) { _unpause(); }

    /// @notice Cancel all signed authorizations with a lower nonce.
    function invalidateNonce(uint256 newNonce) external {
        if (newNonce <= nonces[msg.sender]) revert InvalidNonce();
        nonces[msg.sender] = newNonce;
        emit NonceInvalidated(msg.sender, newNonce);
    }

    function hashPayment(Payment calldata p) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(PAYMENT_TYPEHASH,
            p.paymentId, p.payer, p.payee, p.token, p.amount, p.nonce, p.deadline)));
    }

    /// @notice Point-in-time signature check; does not reserve funds or a nonce.
    /// @dev Contract-wallet validity may change before settlement executes.
    function isValidPaymentSignature(Payment calldata p, bytes calldata signature)
        public view returns (bool)
    {
        // OpenZeppelin Contracts v5.4.0 SignatureChecker address-validation pattern
        // (MIT; see licenses/OpenZeppelin-MIT.txt). Kept local to avoid its
        // Cancun-only Bytes import while preserving this project's Paris target.
        bytes32 paymentHash = hashPayment(p);
        if (p.payer.code.length == 0) {
            (address recovered, ECDSA.RecoverError error, ) = ECDSA.tryRecover(paymentHash, signature);
            return error == ECDSA.RecoverError.NoError && recovered == p.payer;
        }
        (bool success, bytes memory result) = p.payer.staticcall(
            abi.encodeCall(IERC1271.isValidSignature, (paymentHash, signature))
        );
        return success && result.length >= 32 &&
            abi.decode(result, (bytes32)) == bytes32(IERC1271.isValidSignature.selector);
    }

    function settle(Payment calldata p, bytes calldata signature)
        external onlyRole(SETTLER_ROLE) whenNotPaused nonReentrant
    {
        if (p.paymentId == bytes32(0) || p.payer == address(0) ||
            p.payee == address(0) || p.payer == p.payee || p.amount == 0)
            revert InvalidPayment();
        if (p.deadline < block.timestamp) revert Expired();
        if (processed[p.payer][p.paymentId]) revert AlreadyProcessed();
        if (p.nonce != nonces[p.payer]) revert InvalidNonce();
        Policy memory policy = policies[p.token];
        uint256 day = block.timestamp / 1 days;
        uint256 spent = dailySpent[p.payer][p.token][day] + p.amount;
        if (p.amount > policy.perPayment || spent > policy.perDay) revert LimitExceeded();
        if (!isValidPaymentSignature(p, signature))
            revert InvalidSignature();

        // All effects and the token transfer revert together on failure.
        processed[p.payer][p.paymentId] = true;
        nonces[p.payer] = p.nonce + 1;
        dailySpent[p.payer][p.token][day] = spent;
        uint256 beforeBalance = IERC20(p.token).balanceOf(p.payee);
        IERC20(p.token).safeTransferFrom(p.payer, p.payee, p.amount);
        if (IERC20(p.token).balanceOf(p.payee) != beforeBalance + p.amount)
            revert UnexpectedTransferAmount();
        emit PaymentSettled(p.paymentId, p.payer, p.payee, p.token, p.amount, p.nonce);
    }
}


