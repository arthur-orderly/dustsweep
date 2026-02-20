// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IERC20 {
    function transferFrom(address, address, uint256) external returns (bool);
    function approve(address, uint256) external returns (bool);
    function balanceOf(address) external view returns (uint256);
    function allowance(address, address) external view returns (uint256);
}

interface IWETH {
    function withdraw(uint256) external;
}

/// @title BatchSweeper — Sweep dust tokens to ETH in one transaction
/// @notice Audited 2026-02-20: reentrancy guard, router whitelist, approval reset, SafeERC20
contract BatchSweeper {
    address public immutable weth;
    address public owner;
    
    // Reentrancy guard
    uint256 private _locked = 1;
    modifier nonReentrant() {
        require(_locked == 1, "reentrant");
        _locked = 2;
        _;
        _locked = 1;
    }
    
    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }
    
    // Whitelisted DEX routers
    mapping(address => bool) public whitelistedRouters;
    
    event RouterWhitelisted(address indexed router, bool allowed);
    event Swept(address indexed user, uint256 tokenCount, uint256 ethReceived);
    event Rescued(address indexed token, uint256 amount);
    
    constructor(address _weth, address[] memory _routers) {
        weth = _weth;
        owner = msg.sender;
        for (uint i = 0; i < _routers.length; i++) {
            whitelistedRouters[_routers[i]] = true;
            emit RouterWhitelisted(_routers[i], true);
        }
    }
    
    /// @notice Sweep dust tokens through whitelisted DEX routers
    /// @param tokens Array of ERC20 token addresses to sweep
    /// @param amounts Array of token amounts to sweep
    /// @param routers Array of DEX router addresses (must be whitelisted)
    /// @param swapDatas Array of encoded swap calldata for each router
    function sweep(
        address[] calldata tokens,
        uint256[] calldata amounts,
        address[] calldata routers,
        bytes[] calldata swapDatas
    ) external nonReentrant {
        require(
            tokens.length == amounts.length && 
            amounts.length == routers.length && 
            routers.length == swapDatas.length, 
            "length mismatch"
        );
        require(tokens.length <= 50, "too many tokens");
        
        for (uint i = 0; i < tokens.length; i++) {
            // Verify router is whitelisted
            require(whitelistedRouters[routers[i]], "router not whitelisted");
            
            // SafeTransferFrom — handle non-standard ERC20s
            _safeTransferFrom(tokens[i], msg.sender, address(this), amounts[i]);
            
            // Approve router for exact amount
            _safeApprove(tokens[i], routers[i], amounts[i]);
            
            // Execute swap
            (bool success,) = routers[i].call(swapDatas[i]);
            require(success, "swap failed");
            
            // Reset approval to 0 (prevent lingering allowance)
            uint256 remaining = IERC20(tokens[i]).allowance(address(this), routers[i]);
            if (remaining > 0) {
                _safeApprove(tokens[i], routers[i], 0);
            }
        }
        
        // Unwrap WETH
        uint256 wethBal = IERC20(weth).balanceOf(address(this));
        if (wethBal > 0) {
            IWETH(weth).withdraw(wethBal);
        }
        
        // Send ETH to user
        uint256 ethBal = address(this).balance;
        if (ethBal > 0) {
            (bool sent,) = payable(msg.sender).call{value: ethBal}("");
            require(sent, "ETH transfer failed");
        }
        
        emit Swept(msg.sender, tokens.length, ethBal);
    }
    
    // --- Owner functions ---
    
    /// @notice Add or remove a whitelisted router
    function setRouter(address router, bool allowed) external onlyOwner {
        whitelistedRouters[router] = allowed;
        emit RouterWhitelisted(router, allowed);
    }
    
    /// @notice Batch whitelist routers
    function setRouters(address[] calldata routers, bool[] calldata allowed) external onlyOwner {
        require(routers.length == allowed.length, "length mismatch");
        for (uint i = 0; i < routers.length; i++) {
            whitelistedRouters[routers[i]] = allowed[i];
            emit RouterWhitelisted(routers[i], allowed[i]);
        }
    }
    
    /// @notice Rescue stuck tokens (safety net)
    function rescue(address token, uint256 amount) external onlyOwner {
        if (token == address(0)) {
            (bool sent,) = payable(owner).call{value: amount}("");
            require(sent, "ETH rescue failed");
        } else {
            _safeTransfer(token, owner, amount);
        }
        emit Rescued(token, amount);
    }
    
    /// @notice Transfer ownership
    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "zero address");
        owner = newOwner;
    }
    
    // --- Internal safe ERC20 helpers ---
    
    function _safeTransferFrom(address token, address from, address to, uint256 amount) internal {
        (bool success, bytes memory data) = token.call(
            abi.encodeWithSelector(IERC20.transferFrom.selector, from, to, amount)
        );
        require(success && (data.length == 0 || abi.decode(data, (bool))), "transferFrom failed");
    }
    
    function _safeTransfer(address token, address to, uint256 amount) internal {
        (bool success, bytes memory data) = token.call(
            abi.encodeWithSelector(0xa9059cbb, to, amount) // transfer(address,uint256)
        );
        require(success && (data.length == 0 || abi.decode(data, (bool))), "transfer failed");
    }
    
    function _safeApprove(address token, address spender, uint256 amount) internal {
        (bool success, bytes memory data) = token.call(
            abi.encodeWithSelector(IERC20.approve.selector, spender, amount)
        );
        require(success && (data.length == 0 || abi.decode(data, (bool))), "approve failed");
    }
    
    receive() external payable {}
}
