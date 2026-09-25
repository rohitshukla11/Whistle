// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Script, console} from "forge-std/Script.sol";

import {EnsSepolia} from "../../src/integrations/ens/EnsSepolia.sol";
import {IETHRegistrar, IPermissionedRegistry, IRegistry} from "../../src/integrations/ens/IENSv2.sol";

interface IMintableERC20 {
    function mint(address to, uint256 amount) external;
    function approve(address spender, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/// @notice Registers `whistle.eth` on the ENSv2 Sepolia beta, for one year.
///
/// @dev PATH CHOSEN: register now with a PLACEHODER subregistry, repoint later.
///      `ETHRegistrar.REGISTRATION_ROLE_BITMAP` grants the owner
///      `ROLE_SET_SUBREGISTRY | ROLE_SET_SUBREGISTRY_ADMIN | ROLE_SET_RESOLVER |
///      ROLE_SET_RESOLVER_ADMIN | ROLE_CAN_TRANSFER_ADMIN`, so the subregistry can
///      be swapped for Whistle's own root registry after it is deployed. This is
///      proved against deployed bytecode in test/integrations/ens/EnsRootName.t.sol,
///      not merely read from source.
///
///      Registration is commit/reveal: `commit()`, wait MIN_COMMITMENT_AGE (60s on
///      the live deployment), then `register()`. The two steps are separate script
///      functions so the wait happens between transactions.
///
///      Fees are paid in the beta's openly mintable MockUSDC, so this costs nothing
///      real. Run with:
///        forge script script/ens/RegisterWhistleRoot.s.sol:RegisterWhistleRoot \
///          --sig "commitStep()" --rpc-url sepolia --broadcast
///        (wait ~70s)
///        forge script script/ens/RegisterWhistleRoot.s.sol:RegisterWhistleRoot \
///          --sig "registerStep()" --rpc-url sepolia --broadcast
contract RegisterWhistleRoot is Script {
    string internal constant LABEL = "whistle";
    uint64 internal constant DURATION = 365 days;

    IETHRegistrar internal registrar = IETHRegistrar(EnsSepolia.ETH_REGISTRAR);
    IPermissionedRegistry internal ethRegistry = IPermissionedRegistry(EnsSepolia.ETH_REGISTRY);

    /// @dev Derived from the deployer so the same secret is reproducible across the
    ///      two transactions without storing it anywhere.
    function _secret(address owner) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked("whistle.eth-root-commit-v1", owner));
    }

    function commitStep() external {
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address owner = vm.addr(pk);

        require(registrar.isAvailable(LABEL), "whistle.eth is no longer available");

        bytes32 commitment = registrar.makeCommitment(
            LABEL, owner, _secret(owner), IRegistry(address(0)), address(0), DURATION, bytes32(0)
        );

        vm.startBroadcast(pk);
        registrar.commit(commitment);
        vm.stopBroadcast();

        console.log("committed for owner", owner);
        console.log("wait at least 60s, then run registerStep()");
    }

    function registerStep() external {
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address owner = vm.addr(pk);

        (uint256 base, uint256 premium) =
            registrar.getRegisterPrice(LABEL, DURATION, EnsSepolia.MOCK_USDC);
        uint256 fee = base + premium;

        vm.startBroadcast(pk);
        IMintableERC20 token = IMintableERC20(EnsSepolia.MOCK_USDC);
        if (token.balanceOf(owner) < fee) token.mint(owner, fee * 2);
        token.approve(EnsSepolia.ETH_REGISTRAR, fee);

        uint256 tokenId = registrar.register(
            LABEL,
            owner,
            _secret(owner),
            IRegistry(address(0)), // placeholder, repointed after the root registry deploys
            address(0), // placeholder resolver
            DURATION,
            EnsSepolia.MOCK_USDC,
            bytes32(0)
        );
        vm.stopBroadcast();

        console.log("registered whistle.eth");
        console.log("  owner  ", owner);
        console.log("  tokenId", tokenId);
        console.log("  fee    ", fee);
        console.log("  expiry ", ethRegistry.getExpiry(tokenId));
    }

    /// @notice Point `whistle.eth` at Whistle's root Permissioned Registry.
    /// @dev Run after AgentRegistry.deployRootRegistry.
    function repointStep(address rootRegistry) external {
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        uint256 tokenId = ethRegistry.getTokenId(uint256(keccak256(bytes(LABEL))));

        vm.startBroadcast(pk);
        ethRegistry.setSubregistry(tokenId, IRegistry(rootRegistry));
        vm.stopBroadcast();

        console.log("whistle.eth subregistry ->", rootRegistry);
    }
}
