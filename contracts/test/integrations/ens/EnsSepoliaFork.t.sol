// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";

import {EnsSepolia} from "../../../src/integrations/ens/EnsSepolia.sol";
import {
    IETHRegistrar,
    IPermissionedRegistry,
    IRegistry,
    IVerifiableFactory
} from "../../../src/integrations/ens/IENSv2.sol";

/// @notice Smoke tests against the LIVE ENSv2 Sepolia beta.
/// @dev Purpose is provenance, not logic: every selector Whistle depends on is
///      exercised against the deployed bytecode, so if the beta drifts from the
///      pinned source this fails loudly instead of silently mismatching. The ENS
///      docs warn the interfaces are "not yet final", and Sepolia was redeployed
///      on 2026-09-15, so this is the guard rail for that risk.
///
///      Skips itself when SEPOLIA_RPC_URL is unset so the core suite stays runnable
///      offline.
contract EnsSepoliaForkTest is Test {
    /// @dev Pinned so the fork cache is reusable and results are reproducible.
    uint256 internal constant FORK_BLOCK = 11_748_867;

    IPermissionedRegistry internal ethRegistry = IPermissionedRegistry(EnsSepolia.ETH_REGISTRY);
    IETHRegistrar internal registrar = IETHRegistrar(EnsSepolia.ETH_REGISTRAR);

    bool internal forked;

    function setUp() public {
        string memory url = vm.envOr("SEPOLIA_RPC_URL", string(""));
        if (bytes(url).length == 0) return;
        vm.createSelectFork(url, FORK_BLOCK);
        forked = true;
    }

    modifier onlyForked() {
        if (!forked) {
            emit log("SEPOLIA_RPC_URL unset - skipping ENS fork test");
            return;
        }
        _;
    }

    function test_DeployedContractsHaveCode() public onlyForked {
        assertGt(EnsSepolia.ETH_REGISTRY.code.length, 0, "ETHRegistry has no code");
        assertGt(EnsSepolia.ETH_REGISTRAR.code.length, 0, "ETHRegistrar has no code");
        assertGt(EnsSepolia.ROOT_REGISTRY.code.length, 0, "RootRegistry has no code");
        assertGt(EnsSepolia.VERIFIABLE_FACTORY.code.length, 0, "VerifiableFactory has no code");
        assertGt(EnsSepolia.USER_REGISTRY_IMPL.code.length, 0, "UserRegistryImpl has no code");
        assertGt(EnsSepolia.PERMISSIONED_RESOLVER_IMPL.code.length, 0, "PermissionedResolverImpl has no code");
        assertGt(EnsSepolia.UNIVERSAL_RESOLVER_V2.code.length, 0, "UniversalResolverV2 has no code");
        assertGt(EnsSepolia.MOCK_USDC.code.length, 0, "ENS MockUSDC has no code");
    }

    /// @dev `whistle.eth` was registered on 2026-09-22 in Sepolia block 11,753,322
    ///      (tx 0x19d0bdeac2947707d45e4117b71a5354e6f35c41b113c191b343204dd3764696).
    ///      This suite's own FORK_BLOCK predates that, so the ownership check has to
    ///      re-fork at a later block.
    uint256 internal constant LIVE_NAME_FORK_BLOCK = 11_753_325;

    /// @dev The deployer that holds the name. Overridable so a re-registration under
    ///      a different key does not need a code change.
    address internal constant DEFAULT_ROOT_OWNER = 0x68343Aa0598b7FCAA102769D172e59cdDfae10f2;

    /// @notice The name the whole demo namespace hangs off is ours, not merely free.
    /// @dev This used to assert availability. It now asserts the registration that
    ///      replaced it, which is the fact the rest of the build depends on: if the
    ///      beta is redeployed, `whistle.eth` reverts to AVAILABLE and this fails.
    function test_WhistleEthIsRegisteredToDeployer() public onlyForked {
        vm.createSelectFork(vm.envString("SEPOLIA_RPC_URL"), LIVE_NAME_FORK_BLOCK);

        address expectedOwner = vm.envOr("WHISTLE_ROOT_OWNER", DEFAULT_ROOT_OWNER);
        uint256 tokenId = ethRegistry.getTokenId(uint256(keccak256(bytes("whistle"))));

        assertFalse(registrar.isAvailable("whistle"), "whistle.eth reads as available - beta redeployed?");
        assertEq(
            uint256(ethRegistry.getStatus(tokenId)),
            uint256(IPermissionedRegistry.Status.REGISTERED),
            "whistle.eth is not REGISTERED"
        );
        assertEq(ethRegistry.getOwner(tokenId), expectedOwner, "whistle.eth owner changed");
        assertGt(ethRegistry.getExpiry(tokenId), block.timestamp, "whistle.eth has expired");
    }

    /// @notice A name that is definitely taken, to prove the check discriminates.
    function test_AvailabilityCheckDiscriminates() public onlyForked {
        // If every label came back available the test above would be vacuous.
        bool anyTaken;
        string[3] memory taken = ["eth", "test", "ens"];
        for (uint256 i = 0; i < taken.length; ++i) {
            if (!registrar.isAvailable(taken[i])) anyTaken = true;
        }
        assertTrue(anyTaken, "no label reported as taken - availability check is vacuous");
    }

    /// @notice Registration is priced in an ERC20 on the beta, not ether.
    function test_RegisterPriceIsQuotableInMockUSDC() public onlyForked {
        (uint256 base, uint256 premium) =
            registrar.getRegisterPrice("whistle", 365 days, EnsSepolia.MOCK_USDC);

        emit log_named_uint("whistle.eth base price (MockUSDC, 1y)", base);
        emit log_named_uint("whistle.eth premium", premium);
        assertGt(base, 0, "registrar quoted a zero base price");
    }

    /// @notice `makeCommitment` is pure, so it proves the selector and argument
    ///         encoding line up with the deployed contract without spending gas.
    function test_MakeCommitmentMatchesDeployedEncoding() public onlyForked {
        bytes32 secret = keccak256("whistle-demo-secret");
        bytes32 commitment = registrar.makeCommitment(
            "whistle", address(this), secret, IRegistry(address(0)), address(0), 365 days, bytes32(0)
        );
        assertTrue(commitment != bytes32(0), "makeCommitment returned zero");
        assertEq(registrar.commitmentAt(commitment), 0, "unexpected pre-existing commitment");
    }

    /// @notice The EAC surface Whistle's permission model depends on.
    function test_RegistryExposesEnhancedAccessControl() public onlyForked {
        uint256 root = ethRegistry.ROOT_RESOURCE();
        assertEq(root, 0, "ROOT_RESOURCE is not 0x0 as documented");

        // A random address holds no roles anywhere.
        assertEq(ethRegistry.roles(root, address(0xdead)), 0, "stray address holds root roles");
        assertFalse(
            ethRegistry.hasRootRoles(EnsSepolia.ROLE_REGISTRAR, address(0xdead)),
            "stray address holds ROLE_REGISTRAR"
        );
    }

    /// @notice The factory used to deploy per-user registries and per-agent resolvers.
    function test_VerifiableFactoryIsReachable() public onlyForked {
        IVerifiableFactory factory = IVerifiableFactory(EnsSepolia.VERIFIABLE_FACTORY);
        // `verifyContract` on a non-proxy must not succeed silently.
        try factory.verifyContract(address(this)) returns (address impl) {
            assertEq(impl, address(0), "factory verified a non-proxy");
        } catch {
            // Reverting is also a correct answer here.
        }
    }
}
