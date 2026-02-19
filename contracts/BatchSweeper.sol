// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IERC20 {
    function transferFrom(address, address, uint256) external returns (bool);
    function approve(address, uint256) external returns (bool);
    function balanceOf(address) external view returns (uint256);
}

interface IWETH {
    function withdraw(uint256) external;
}

contract BatchSweeper {
    address public immutable weth;
    
    constructor(address _weth) {
        weth = _weth;
    }
    
    function sweep(
        address[] calldata tokens,
        uint256[] calldata amounts,
        address[] calldata routers,
        bytes[] calldata swapDatas
    ) external {
        require(tokens.length == amounts.length && amounts.length == routers.length && routers.length == swapDatas.length, "length mismatch");
        
        for (uint i = 0; i < tokens.length; i++) {
            IERC20(tokens[i]).transferFrom(msg.sender, address(this), amounts[i]);
            IERC20(tokens[i]).approve(routers[i], amounts[i]);
            (bool success,) = routers[i].call(swapDatas[i]);
            require(success, "swap failed");
        }
        
        uint256 wethBal = IERC20(weth).balanceOf(address(this));
        if (wethBal > 0) {
            IWETH(weth).withdraw(wethBal);
        }
        
        uint256 ethBal = address(this).balance;
        if (ethBal > 0) {
            (bool sent,) = payable(msg.sender).call{value: ethBal}("");
            require(sent, "ETH transfer failed");
        }
    }
    
    receive() external payable {}
}
