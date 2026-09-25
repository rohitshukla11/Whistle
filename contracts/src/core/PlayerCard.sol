// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title PlayerCard
/// @notice One ERC-20 per player per fixture. 18 decimals.
/// @dev Deployed as an EIP-1167 minimal-proxy clone of a single implementation, so
///      a 36-card fixture costs ~36 clone deployments instead of 36 full contract
///      deployments. Clones cannot run a constructor, so:
///        - configuration moves to {initialize}, guarded against re-entry;
///        - `name()` and `symbol()` are overridden to read clone storage, because
///          OpenZeppelin's ERC20 sets its own copies in a constructor the clone
///          never executes.
///
///      Supply is controlled exclusively by the fixture's SettlementPot, which is
///      the only contract that can keep the pricing aggregates in step with a supply
///      change. Minting anywhere else would silently corrupt every price.
contract PlayerCard is ERC20 {
    /// @notice Basis points of total supply any one address may hold.
    uint256 public constant MAX_HOLDER_BPS = 500; // 5%

    string private _cardName;
    string private _cardSymbol;

    /// @notice The fixture's SettlementPot. Sole mint/burn authority.
    address public pot;

    /// @notice The FixtureFactory. Manages cap exemptions only.
    address public factory;

    /// @notice Player id within the fixture.
    uint16 public playerId;

    bool private _initialized;

    /// @notice Addresses the holder cap does not apply to.
    /// @dev Required for MMVault (seeds 200 units of every card, so it is briefly
    ///      100% of supply), PoolManager (custodies pooled liquidity) and the hook
    ///      (transiently holds fill inventory). Without exemptions, seeding a pool
    ///      would revert against the cap before any human could trade.
    mapping(address => bool) public capExempt;

    error OnlyPot();
    error OnlyFactory();
    error AlreadyInitialized();
    error HolderCapExceeded(address holder, uint256 balance, uint256 maxAllowed);

    event CapExemptSet(address indexed account, bool exempt);

    /// @dev Runs only for the implementation contract, which is locked immediately
    ///      so nobody can initialize and impersonate it.
    constructor() ERC20("", "") {
        _initialized = true;
    }

    function initialize(string memory name_, string memory symbol_, address pot_, address factory_, uint16 playerId_)
        external
    {
        if (_initialized) revert AlreadyInitialized();
        _initialized = true;
        _cardName = name_;
        _cardSymbol = symbol_;
        pot = pot_;
        factory = factory_;
        playerId = playerId_;
        capExempt[pot_] = true;
    }

    function name() public view override returns (string memory) {
        return _cardName;
    }

    function symbol() public view override returns (string memory) {
        return _cardSymbol;
    }

    modifier onlyPot() {
        if (msg.sender != pot) revert OnlyPot();
        _;
    }

    function setCapExempt(address account, bool exempt) external {
        if (msg.sender != factory) revert OnlyFactory();
        capExempt[account] = exempt;
        emit CapExemptSet(account, exempt);
    }

    function mint(address to, uint256 units) external onlyPot {
        _mint(to, units);
    }

    function burn(address from, uint256 units) external onlyPot {
        _burn(from, units);
    }

    /// @dev Cap is checked after the balance change so it accounts for the mint
    ///      itself: minting `x` into supply `s` leaves the holder at `x/(s+x)`.
    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        if (to == address(0) || capExempt[to]) return;

        uint256 supply = totalSupply();
        if (supply == 0) return;

        uint256 maxAllowed = (supply * MAX_HOLDER_BPS) / 10_000;
        uint256 balance = balanceOf(to);
        if (balance > maxAllowed) revert HolderCapExceeded(to, balance, maxAllowed);
    }
}
