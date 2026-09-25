// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @title EnsSepolia
/// @notice ENSv2 Sepolia beta addresses and role constants.
///
/// @dev PROVENANCE. Every address below is taken from the ENS deployment artifacts
///      at `contracts/deployments/sepolia/<Name>.json` in
///      github.com/ensdomains/contracts-v2, pinned to tag
///      `sepolia-deployment-2026-09-15` (commit
///      f2f0a05e6c1711134b73204a1e37f8e6c1aea6ab), and independently confirmed to
///      carry code on Sepolia. They also match
///      <https://docs.ens.domains/learn/deployments/> exactly.
///
///      The ENSv2 docs state the contracts are "not yet final and may change prior
///      to mainnet deployment", and Sepolia was redeployed on 2026-09-15. Re-verify
///      before trusting these beyond this hackathon.
library EnsSepolia {
    // ------------------------------------------------------------- registries
    address internal constant ETH_REGISTRY = 0x657eA849311d3D5823348ddEd7C2AaAFb3EDE09E;
    address internal constant ETH_REGISTRAR = 0xAbe76F6C8DFcEd81AA5A2bB8034202A7136b94ca;
    address internal constant ROOT_REGISTRY = 0x9703DBD26dAB89504490994138cF2c575251a9cE;
    address internal constant BATCH_REGISTRAR = 0xBe68Ff9aFc7D5A1864ffef5C82DE0A1C13E6B529;

    /// @notice Implementation cloned by the VerifiableFactory for per-user subname
    ///         registries (the nested registry under `<user>.whistle.eth`).
    address internal constant USER_REGISTRY_IMPL = 0xA80338aAA8D23831cEa25E858D1774534aBb0263;

    // ------------------------------------------------------------- resolvers
    /// @notice Implementation cloned for a PER-AGENT Permissioned Resolver.
    /// @dev One instance per agent is what makes split write rights meaningful:
    ///      resolver roles have no per-name scoping, so agents sharing a resolver
    ///      could overwrite each other's records. See PLAN.md section 1.
    address internal constant PERMISSIONED_RESOLVER_IMPL = 0x14F09Fd05d4585759e54844DC9B00147131Cf243;
    address internal constant PUBLIC_RESOLVER_V2 = 0xd7e590Ad0E92A6aC1d81f4483A9B951D3585a50F;
    address internal constant UNIVERSAL_RESOLVER_V2 = 0x5d25C1D6aCBb71B7a28AA7899618a3412a8303e3;
    address internal constant UNIVERSAL_RESOLVER_PROXY = 0xeEeEEEeE14D718C2B47D9923Deab1335E144EeEe;

    // --------------------------------------------------------------- factory
    address internal constant VERIFIABLE_FACTORY = 0x9e726Eb570beb6BCEb495AB8cdA7df517d4e841C;

    // ------------------------------------------------- beta payment tokens
    /// @notice ENS's own mock tokens on the beta; registration fees are paid in one.
    address internal constant MOCK_USDC = 0x16f95D91DBa7dA3Aca778Ec053dF0FF6C6A8aA8e;
    address internal constant MOCK_DAI = 0x278053aCc97888E63Ec81c80FEC641Bf0Bf19664;

    // ---------------------------------------------------------------- roles
    /// @dev Verbatim from `src/registry/libraries/RegistryRolesLib.sol` at the
    ///      pinned commit. Each role occupies one nybble; the admin counterpart is
    ///      the same bit shifted left by 128.
    uint256 internal constant ROLE_REGISTRAR = 1 << 0;
    uint256 internal constant ROLE_REGISTRAR_ADMIN = ROLE_REGISTRAR << 128;
    uint256 internal constant ROLE_SET_PARENT = 1 << 8;
    uint256 internal constant ROLE_UNREGISTER = 1 << 12;
    uint256 internal constant ROLE_UNREGISTER_ADMIN = ROLE_UNREGISTER << 128;
    uint256 internal constant ROLE_RENEW = 1 << 16;
    uint256 internal constant ROLE_SET_SUBREGISTRY = 1 << 20;
    uint256 internal constant ROLE_SET_SUBREGISTRY_ADMIN = ROLE_SET_SUBREGISTRY << 128;
    uint256 internal constant ROLE_SET_RESOLVER = 1 << 24;
    uint256 internal constant ROLE_SET_RESOLVER_ADMIN = ROLE_SET_RESOLVER << 128;
    /// @dev Withholding this is what makes an agent subname NON-TRANSFERABLE.
    uint256 internal constant ROLE_CAN_TRANSFER_ADMIN = (1 << 28) << 128;

    /// @dev Verbatim from `src/resolver/libraries/PermissionedResolverLib.sol`.
    uint256 internal constant ROLE_SET_ADDRESS = 1 << 0;
    uint256 internal constant ROLE_SET_TEXT = 1 << 4;
    uint256 internal constant ROLE_SET_TEXT_ADMIN = ROLE_SET_TEXT << 128;
    uint256 internal constant ROLE_LINK = 1 << 28;
    uint256 internal constant ROLE_UPGRADE = 1 << 124;
}
