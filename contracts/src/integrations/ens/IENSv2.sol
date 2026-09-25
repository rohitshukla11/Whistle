// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @notice Minimal ENSv2 interfaces, copied VERBATIM from
///         github.com/ensdomains/contracts-v2 at tag `sepolia-deployment-2026-09-15`
///         (commit f2f0a05e6c1711134b73204a1e37f8e6c1aea6ab).
///
/// @dev Declared locally rather than vendoring the ENS monorepo, which pulls solady,
///      account-abstraction, nexus, unruggable-gateways and two OpenZeppelin major
///      versions. Each interface below cites the exact source path it was copied
///      from; nothing here is reconstructed from documentation or memory. Every
///      selector is additionally exercised against the live Sepolia deployment in
///      test/integrations/ens, so a drift in the beta shows up as a failing test
///      rather than a silent mismatch.

/// @dev src/registry/interfaces/IRegistry.sol
interface IRegistry {
    function getSubregistry(string calldata label) external view returns (IRegistry);
    function getResolver(string calldata label) external view returns (address);
    function getParent() external view returns (IRegistry parent, string memory label);
}

/// @dev src/access-control/interfaces/IEACGrantInitializable.sol
struct Grant {
    address account;
    uint256 roleBitmap;
}

/// @dev src/access-control/interfaces/IEnhancedAccessControl.sol
interface IEnhancedAccessControl {
    function grantRoles(uint256 resource, uint256 roleBitmap, address account) external returns (bool);
    function grantRootRoles(uint256 roleBitmap, address account) external returns (bool);
    function revokeRoles(uint256 resource, uint256 roleBitmap, address account) external returns (bool);
    function revokeRootRoles(uint256 roleBitmap, address account) external returns (bool);
    function ROOT_RESOURCE() external view returns (uint256);
    function roles(uint256 resource, address account) external view returns (uint256);
    function hasRootRoles(uint256 roleBitmap, address account) external view returns (bool);
    function hasRoles(uint256 resource, uint256 roleBitmap, address account) external view returns (bool);
}

/// @dev src/registry/interfaces/IStandardRegistry.sol and IPermissionedRegistry.sol
interface IPermissionedRegistry is IEnhancedAccessControl, IRegistry {
    enum Status {
        AVAILABLE,
        RESERVED,
        REGISTERED
    }

    struct State {
        Status status;
        uint64 expiry;
        address latestOwner;
        uint256 tokenId;
        uint256 resource;
    }

    function register(
        string calldata label,
        address owner,
        IRegistry registry,
        address resolver,
        uint256 roleBitmap,
        uint64 expiry
    ) external returns (uint256 tokenId);

    function renew(uint256 anyId, uint64 newExpiry) external;
    function unregister(uint256 anyId) external;
    function setSubregistry(uint256 anyId, IRegistry registry) external;
    function setResolver(uint256 anyId, address resolver) external;
    function getExpiry(uint256 anyId) external view returns (uint64 expiry);

    function getState(uint256 anyId) external view returns (State memory state);
    function getStatus(uint256 anyId) external view returns (Status status);
    function getResource(uint256 anyId) external view returns (uint256 resource);
    function getTokenId(uint256 anyId) external view returns (uint256 tokenId);
    function getOwner(uint256 anyId) external view returns (address owner);
    function latestOwnerOf(uint256 tokenId) external view returns (address owner);
}

/// @dev ERC1155 surface of the registry; names are tokens.
interface IRegistryToken {
    function safeTransferFrom(address from, address to, uint256 id, uint256 amount, bytes calldata data)
        external;
    function balanceOf(address account, uint256 id) external view returns (uint256);
}

/// @dev src/registrar/interfaces/IETHRegistrar.sol — commit/reveal, ERC20 payment.
interface IETHRegistrar {
    function commit(bytes32 commitment) external;

    function register(
        string memory label,
        address owner,
        bytes32 secret,
        IRegistry subregistry,
        address resolver,
        uint64 duration,
        address paymentToken,
        bytes32 referrer
    ) external returns (uint256);

    function makeCommitment(
        string calldata label,
        address owner,
        bytes32 secret,
        IRegistry subregistry,
        address resolver,
        uint64 duration,
        bytes32 referrer
    ) external pure returns (bytes32);

    function commitmentAt(bytes32 commitment) external view returns (uint64);
    function isAvailable(string memory label) external view returns (bool);

    function getRegisterPrice(string calldata label, uint64 duration, address paymentToken)
        external
        view
        returns (uint256 base, uint256 premium);
}

/// @dev src/resolver/interfaces/IPermissionedResolver.sol and setters/ITextSetter.sol
interface IPermissionedResolver is IEnhancedAccessControl {
    function grantSetterRoles(bytes calldata setter, address account) external returns (bool);
    function linkToNode(bytes calldata sourceName, bytes32 targetNode) external;
    function linkToRecord(bytes calldata sourceName, uint256 recordId) external;
    function getRecordId(bytes32 node) external view returns (uint256);

    function decodeSetter(bytes calldata setter)
        external
        pure
        returns (bytes memory arg, uint256 resource, uint256 roleBitmap);

    function setText(bytes calldata name, string calldata key, string calldata value) external;
    function setAddress(bytes calldata name, uint256 coinType, bytes calldata addressBytes) external;

    /// @dev IExtendedResolver, implemented as a plain public view on
    ///      `AbstractRecordResolver` — so records are readable on-chain with no
    ///      gateway. `name` is DNS-encoded; the node inside `data` is ignored and
    ///      re-derived from `name`.
    function resolve(bytes calldata name, bytes calldata data) external view returns (bytes memory);
}

/// @dev src/resolver/interfaces/IPermissionedResolverInitializable.sol
interface IPermissionedResolverInitializable {
    function initialize(Grant[] calldata grants, bytes[] calldata calls) external;
}

/// @dev UniversalResolverV2 — walks the registry hierarchy to find the resolver for
///      a DNS-encoded name, then dispatches a profile call against it.
interface IUniversalResolver {
    function findResolver(bytes calldata name)
        external
        view
        returns (address resolver, bytes32 node, uint256 offset);

    function resolve(bytes calldata name, bytes calldata data)
        external
        view
        returns (bytes memory result, address resolver);
}

/// @dev lib/verifiable-factory — `deployProxy(implementation, salt, initData)`.
interface IVerifiableFactory {
    function deployProxy(address implementation, uint256 salt, bytes calldata initData)
        external
        returns (address);
    function verifyContract(address proxy) external view returns (address);
}
