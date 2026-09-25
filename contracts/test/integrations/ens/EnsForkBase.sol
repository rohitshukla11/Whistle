// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";

import {EnsSepolia} from "../../../src/integrations/ens/EnsSepolia.sol";
import {IETHRegistrar, IPermissionedRegistry, IRegistry} from "../../../src/integrations/ens/IENSv2.sol";

interface IMintableERC20 {
    function mint(address to, uint256 amount) external;
    function approve(address spender, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/// @notice Shared rig for tests that run against the live ENSv2 Sepolia beta.
///
/// @dev Two modes, both of which must pass:
///
///      - `WHISTLE_ROOT_OWNER` set: treat `whistle.eth` as already registered
///        on-chain to that address and `vm.prank` as it. This is the mode that
///        exercises the REAL name after step 8 registers it.
///      - unset: self-register `whistle.eth` inside the fork via the genuine
///        commit/reveal flow, paying with freshly minted beta MockUSDC.
///
///      Either way the tests below act on a name that went through the real
///      registrar, so nothing about the permission model is simulated.
abstract contract EnsForkBase is Test {
    /// @dev Pinned so the fork cache is reusable and results are reproducible.
    ///      Predates the real registration of `whistle.eth`, so it is only valid for
    ///      the self-register mode.
    uint256 internal constant FORK_BLOCK = 11_748_867;

    /// @dev `whistle.eth` was registered on Sepolia in block 11,753,322
    ///      (tx 0x19d0bdea...4696). The live-owner mode must fork at or after that
    ///      block or the name simply does not exist yet on the fork.
    uint256 internal constant REGISTRATION_BLOCK = 11_753_322;

    /// @dev Pinned one block past registration, for the same cache-reuse reason.
    uint256 internal constant LIVE_NAME_FORK_BLOCK = 11_753_325;

    /// @dev Read live from the deployed registrar at the pinned block.
    uint64 internal constant MIN_COMMITMENT_AGE = 60;
    uint64 internal constant REGISTRATION_DURATION = 365 days;

    string internal constant ROOT_LABEL = "whistle";

    IPermissionedRegistry internal ethRegistry = IPermissionedRegistry(EnsSepolia.ETH_REGISTRY);
    IETHRegistrar internal registrar = IETHRegistrar(EnsSepolia.ETH_REGISTRAR);
    IMintableERC20 internal feeToken = IMintableERC20(EnsSepolia.MOCK_USDC);

    bool internal forked;
    bool internal usingLiveName;
    address internal rootOwner;
    uint256 internal rootTokenId;

    /// @dev The fork block depends on the mode, because the two modes need
    ///      different chain histories: the self-register path must run at a block
    ///      where `whistle.eth` is still AVAILABLE, and the live-owner path at a
    ///      block where it is already REGISTERED. `ENS_FORK_BLOCK` overrides both,
    ///      and 0 means "latest".
    function _setUpFork() internal returns (bool) {
        string memory url = vm.envOr("SEPOLIA_RPC_URL", string(""));
        if (bytes(url).length == 0) return false;

        uint256 blockNumber = vm.envOr("ENS_FORK_BLOCK", uint256(0));
        if (blockNumber == 0) {
            blockNumber =
                vm.envOr("WHISTLE_ROOT_OWNER", address(0)) != address(0) ? LIVE_NAME_FORK_BLOCK : FORK_BLOCK;
        }

        vm.createSelectFork(url, blockNumber);
        forked = true;
        return true;
    }

    /// @notice A test address guaranteed to behave as a plain EOA on the fork.
    /// @dev Deterministic `makeAddr` addresses can collide with real accounts on a
    ///      forked network. `makeAddr("alice")` happens to carry an EIP-7702
    ///      delegation on Sepolia (23 bytes of `0xef0100||address`), which makes
    ///      `code.length > 0` and trips the ERC-1155 acceptance check when a name is
    ///      minted to it. Clearing the code restores EOA semantics.
    function _eoa(string memory label) internal returns (address account) {
        account = makeAddr(label);
        vm.etch(account, "");
    }

    modifier onlyForked() {
        if (!forked) {
            emit log("SEPOLIA_RPC_URL unset - skipping ENS fork test");
            return;
        }
        _;
    }

    /// @notice Make `whistle.eth` exist and be owned by `rootOwner`.
    function _ensureRootName() internal {
        address configured = vm.envOr("WHISTLE_ROOT_OWNER", address(0));

        if (configured != address(0)) {
            usingLiveName = true;
            rootOwner = configured;
            rootTokenId = ethRegistry.getTokenId(uint256(keccak256(bytes(ROOT_LABEL))));

            IPermissionedRegistry.Status status = ethRegistry.getStatus(rootTokenId);
            require(
                status == IPermissionedRegistry.Status.REGISTERED,
                "WHISTLE_ROOT_OWNER set but whistle.eth is not registered on-chain"
            );
            require(
                ethRegistry.getOwner(rootTokenId) == configured,
                "WHISTLE_ROOT_OWNER does not own whistle.eth"
            );
            emit log_named_address("using LIVE whistle.eth owned by", rootOwner);
            return;
        }

        rootOwner = _eoa("whistleRootOwner");
        rootTokenId = _registerRootInFork(rootOwner);
        emit log_named_address("self-registered whistle.eth in fork for", rootOwner);
    }

    /// @dev The genuine commit/reveal flow, paid in beta MockUSDC.
    ///      Registers with a placeholder subregistry and resolver; the owner keeps
    ///      ROLE_SET_SUBREGISTRY so both can be repointed afterwards.
    function _registerRootInFork(address owner) internal returns (uint256 tokenId) {
        vm.deal(owner, 10 ether);

        (uint256 base, uint256 premium) =
            registrar.getRegisterPrice(ROOT_LABEL, REGISTRATION_DURATION, EnsSepolia.MOCK_USDC);
        uint256 fee = base + premium;

        // The beta fee token is openly mintable, so registration costs nothing real.
        feeToken.mint(owner, fee * 2);

        bytes32 secret = keccak256("whistle-fork-secret");
        bytes32 commitment = registrar.makeCommitment(
            ROOT_LABEL, owner, secret, IRegistry(address(0)), address(0), REGISTRATION_DURATION, bytes32(0)
        );

        vm.startPrank(owner);
        feeToken.approve(EnsSepolia.ETH_REGISTRAR, type(uint256).max);
        registrar.commit(commitment);
        vm.warp(block.timestamp + MIN_COMMITMENT_AGE + 1);
        tokenId = registrar.register(
            ROOT_LABEL,
            owner,
            secret,
            IRegistry(address(0)),
            address(0),
            REGISTRATION_DURATION,
            EnsSepolia.MOCK_USDC,
            bytes32(0)
        );
        vm.stopPrank();
    }
}
