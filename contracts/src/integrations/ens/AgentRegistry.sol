// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IAgentAuth} from "../../interfaces/IAgentAuth.sol";
import {EnsSepolia} from "./EnsSepolia.sol";
import {WhistleNames} from "./WhistleNames.sol";
import {
    Grant,
    IPermissionedRegistry,
    IPermissionedResolver,
    IRegistry,
    IVerifiableFactory
} from "./IENSv2.sol";

/// @dev ENSIP-5 text profile selector, `text(bytes32,string)`. The resolver ignores
///      the node argument and derives it from the DNS-encoded name instead.
interface ITextResolverProfile {
    function text(bytes32 node, string calldata key) external view returns (string memory);
}

/// @title AgentRegistry
/// @notice ENSv2 adapter: the permission system for Whistle agents.
///
/// @dev ## Why ENS is load-bearing here
///
/// Nothing about an agent's authority lives in this contract's own judgement. Every
/// question {isAuthorized} asks is answered by reading ENSv2 on-chain, every call:
///
/// | question | answered by |
/// |---|---|
/// | does the agent still exist? | `registry.getStatus(tokenId) == REGISTERED` |
/// | has its mandate expired?    | `registry.getExpiry(tokenId)` |
/// | has the user revoked it?    | `registry.hasRoles(resource, ROLE_TRADE, agent)` |
/// | which fixture may it trade? | resolver text record `fixture` |
/// | how much may it spend?      | resolver text record `spend-cap` |
///
/// Delete ENS and there is no access control left. The only state this contract
/// keeps of its own is an index (agent address -> which name) and the running spend
/// total; the CAP is authoritative in ENS, the tally is bookkeeping.
///
/// ## Namespace
///
///     whistle.eth                        root, subregistry = rootRegistry
///     |- <user>.whistle.eth              user subname, subregistry = per-user registry
///        |- agent-N.<user>.whistle.eth   non-transferable, expiring, parent-revocable
///
/// ## Per-agent resolvers
///
/// Each agent gets its OWN Permissioned Resolver instance. ENSv2 resolver roles are
/// scoped to (resolver instance, record key) and have NO per-name scoping — the docs
/// are explicit. Agents sharing one resolver could therefore overwrite each other's
/// `status` and `pnl-live`. A resolver per agent is what makes the split write
/// rights actually isolate anything. See PLAN.md section 1.
contract AgentRegistry is IAgentAuth {
    using WhistleNames for string[];

    // ------------------------------------------------------------- constants

    /// @dev Roles minted onto an agent subname. `ROLE_CAN_TRANSFER_ADMIN` is
    ///      deliberately ABSENT: without it `PermissionedRegistry` reverts any
    ///      transfer, which is what makes an agent mandate non-transferable.
    uint256 internal constant AGENT_ROLE_BITMAP = EnsSepolia.ROLE_SET_RESOLVER;

    /// @dev Roles this contract needs on a freshly deployed per-agent resolver:
    ///      write the initial records, link the name, and delegate per-key rights.
    ///      `ROLE_SET_TEXT` is dropped again at the end of {createAgent}.
    uint256 internal constant RESOLVER_BOOTSTRAP_ROLES =
        EnsSepolia.ROLE_SET_TEXT | EnsSepolia.ROLE_SET_TEXT_ADMIN | EnsSepolia.ROLE_LINK
            | (EnsSepolia.ROLE_LINK << 128);

    string internal constant KEY_FIXTURE = "fixture";
    string internal constant KEY_STRATEGY = "strategy";
    string internal constant KEY_SPEND_CAP = "spend-cap";
    string internal constant KEY_SLIPPAGE = "slippage";
    string internal constant KEY_LAST_ACTION = "last-action";
    string internal constant KEY_STATUS = "status";
    string internal constant KEY_PNL_LIVE = "pnl-live";
    string internal constant KEY_MATCHES_PLAYED = "matches-played";
    string internal constant KEY_PNL_HISTORY = "pnl-history";
    string internal constant KEY_REVOKED_AT = "revoked-at";

    // --------------------------------------------------------------- storage

    IVerifiableFactory public immutable verifiableFactory;
    address public immutable userRegistryImpl;
    address public immutable permissionedResolverImpl;

    /// @notice Registry attached as the subregistry of `whistle.eth`.
    IPermissionedRegistry public rootRegistry;

    address public operator;

    /// @notice May write `matches-played`, `pnl-history`, `revoked-at`.
    address public platform;

    /// @notice Labels of the root name, e.g. ["whistle","eth"].
    string[] internal rootLabels;

    struct UserAccount {
        IPermissionedRegistry registry;
        string label;
        uint32 agentCount;
        bool exists;
    }

    struct AgentRecord {
        address user;
        IPermissionedRegistry registry;
        address resolver;
        uint256 tokenId;
        uint256 resource;
        uint256 fixtureId;
        uint256 templateId;
        uint256 spentUSDC;
        bytes dnsName;
        bytes32 node;
        string fqdn;
        bool exists;
    }

    mapping(address => UserAccount) public userAccounts;
    mapping(address => AgentRecord) internal agentRecords;
    address[] public allAgents;

    // ---------------------------------------------------------------- errors

    error OnlyOperator();
    error OnlyPlatform();
    error OnlyMarket();
    error RootNotConfigured();
    error UserAlreadyRegistered();
    error UnknownUser();
    error UnknownAgent();
    error AgentAddressInUse();
    error SpendCapExceeded(uint256 requested, uint256 remaining);

    // ---------------------------------------------------------------- events

    event RootRegistryDeployed(address registry);
    event UserRegistered(address indexed user, string label, address registry, uint256 tokenId);
    event AgentCreated(
        address indexed agent, address indexed user, string fqdn, address resolver, uint64 expiry
    );
    event AgentRevoked(address indexed agent, string fqdn);
    event SpendRecorded(address indexed agent, uint256 amount, uint256 totalSpent);

    // ----------------------------------------------------------- constructor

    constructor(address operator_, address platform_) {
        operator = operator_;
        platform = platform_;
        verifiableFactory = IVerifiableFactory(EnsSepolia.VERIFIABLE_FACTORY);
        userRegistryImpl = EnsSepolia.USER_REGISTRY_IMPL;
        permissionedResolverImpl = EnsSepolia.PERMISSIONED_RESOLVER_IMPL;
    }

    modifier onlyOperator() {
        if (msg.sender != operator) revert OnlyOperator();
        _;
    }

    // ------------------------------------------------------------- root setup

    /// @notice Deploy the registry that becomes the subregistry of `whistle.eth`.
    /// @dev Granting this contract root roles on the new registry is what lets it
    ///      mint user subnames later. The operator still has to point
    ///      `whistle.eth` at the result via `ETHRegistry.setSubregistry`, which the
    ///      name's owner holds `ROLE_SET_SUBREGISTRY` for.
    function deployRootRegistry(uint256 salt, string[] calldata rootLabels_)
        external
        onlyOperator
        returns (address registry)
    {
        Grant[] memory grants = new Grant[](1);
        grants[0] = Grant({account: address(this), roleBitmap: _fullRegistryRoles()});

        registry = verifiableFactory.deployProxy(
            userRegistryImpl, salt, abi.encodeWithSignature("initialize((address,uint256)[])", grants)
        );

        rootRegistry = IPermissionedRegistry(registry);
        delete rootLabels;
        for (uint256 i = 0; i < rootLabels_.length; ++i) {
            rootLabels.push(rootLabels_[i]);
        }

        emit RootRegistryDeployed(registry);
    }

    function setPlatform(address platform_) external onlyOperator {
        platform = platform_;
    }

    function setOperator(address operator_) external onlyOperator {
        operator = operator_;
    }

    // -------------------------------------------------------------- users

    /// @notice Mint `<label>.whistle.eth` and give it its own nested registry.
    /// @dev The user's subname is transferable (it is their identity); only the
    ///      agents beneath it are not.
    function registerUser(string calldata label, address user, uint256 salt, uint64 expiry)
        external
        onlyOperator
        returns (address userRegistry, uint256 tokenId)
    {
        if (address(rootRegistry) == address(0)) revert RootNotConfigured();
        if (userAccounts[user].exists) revert UserAlreadyRegistered();

        // This contract keeps root roles on the nested registry so it can mint and
        // revoke agents; the user owns the name itself.
        Grant[] memory grants = new Grant[](2);
        grants[0] = Grant({account: address(this), roleBitmap: _fullRegistryRoles()});
        grants[1] = Grant({account: user, roleBitmap: EnsSepolia.ROLE_SET_RESOLVER});

        userRegistry = verifiableFactory.deployProxy(
            userRegistryImpl, salt, abi.encodeWithSignature("initialize((address,uint256)[])", grants)
        );

        tokenId = rootRegistry.register(
            label,
            user,
            IRegistry(userRegistry),
            EnsSepolia.PUBLIC_RESOLVER_V2,
            EnsSepolia.ROLE_SET_RESOLVER | EnsSepolia.ROLE_SET_RESOLVER_ADMIN
                | EnsSepolia.ROLE_CAN_TRANSFER_ADMIN,
            expiry
        );

        userAccounts[user] =
            UserAccount({registry: IPermissionedRegistry(userRegistry), label: label, agentCount: 0, exists: true});

        emit UserRegistered(user, label, userRegistry, tokenId);
    }

    // -------------------------------------------------------------- agents

    struct CreateAgentParams {
        address user;
        address agent;
        uint256 fixtureId;
        uint256 templateId;
        uint256 spendCapUSDC;
        uint256 slippageBps;
        /// @dev Fixture scheduled full time + 5 minutes.
        uint64 expiry;
        uint256 salt;
    }

    /// @notice Mint an agent subname with its own resolver and split write rights.
    function createAgent(CreateAgentParams calldata p)
        external
        onlyOperator
        returns (address resolver, uint256 tokenId)
    {
        UserAccount storage account = userAccounts[p.user];
        if (!account.exists) revert UnknownUser();
        if (agentRecords[p.agent].exists) revert AgentAddressInUse();

        string memory label = string.concat("agent-", WhistleNames.toString(++account.agentCount));

        resolver = _deployAgentResolver(p.salt);

        tokenId = account.registry.register(
            label, p.agent, IRegistry(address(0)), resolver, AGENT_ROLE_BITMAP, p.expiry
        );

        AgentRecord storage rec = agentRecords[p.agent];
        rec.user = p.user;
        rec.registry = account.registry;
        rec.resolver = resolver;
        rec.tokenId = tokenId;
        rec.resource = account.registry.getResource(tokenId);
        rec.fixtureId = p.fixtureId;
        rec.templateId = p.templateId;
        rec.exists = true;

        {
            string[] memory labels = _agentLabels(label, account.label);
            rec.dnsName = labels.dnsEncode();
            rec.node = labels.namehash();
            rec.fqdn = labels.join();
        }

        allAgents.push(p.agent);

        _writeInitialRecords(rec, p);
        _delegateRecordRights(resolver, p.user, p.agent);

        // Drop blanket write rights so the split is real: from here this contract
        // can still DELEGATE keys (it keeps the admin role) but cannot itself write
        // `spend-cap` or any other record.
        IPermissionedResolver(resolver).revokeRootRoles(EnsSepolia.ROLE_SET_TEXT, address(this));

        emit AgentCreated(p.agent, p.user, rec.fqdn, resolver, p.expiry);
    }

    function _deployAgentResolver(uint256 salt) private returns (address resolver) {
        Grant[] memory grants = new Grant[](1);
        grants[0] = Grant({account: address(this), roleBitmap: RESOLVER_BOOTSTRAP_ROLES});

        bytes[] memory noCalls = new bytes[](0);
        resolver = verifiableFactory.deployProxy(
            permissionedResolverImpl,
            salt,
            abi.encodeWithSignature("initialize((address,uint256)[],bytes[])", grants, noCalls)
        );
    }

    function _writeInitialRecords(AgentRecord storage rec, CreateAgentParams calldata p) private {
        IPermissionedResolver r = IPermissionedResolver(rec.resolver);
        bytes memory name = rec.dnsName;

        // No explicit linkToNode: the resolver creates the record on first write
        // and emits Linked. `linkToNode` is for pointing a name at an EXISTING
        // record and reverts with InvalidRecord if the target has none yet.
        r.setText(name, KEY_FIXTURE, WhistleNames.toString(p.fixtureId));
        r.setText(name, KEY_STRATEGY, WhistleNames.toString(p.templateId));
        r.setText(name, KEY_SPEND_CAP, WhistleNames.toString(p.spendCapUSDC));
        r.setText(name, KEY_SLIPPAGE, WhistleNames.toString(p.slippageBps));
        r.setText(name, KEY_STATUS, "active");
    }

    /// @dev Argument-scoped grants: the resource is derived from the setter's
    ///      arguments, so a grant covers exactly one text key and nothing else.
    function _delegateRecordRights(address resolver, address user, address agent) private {
        IPermissionedResolver r = IPermissionedResolver(resolver);

        // The agent reports on itself.
        r.grantSetterRoles(_textSetter(KEY_LAST_ACTION), agent);
        r.grantSetterRoles(_textSetter(KEY_STATUS), agent);
        r.grantSetterRoles(_textSetter(KEY_PNL_LIVE), agent);

        // The user sets the mandate.
        r.grantSetterRoles(_textSetter(KEY_STRATEGY), user);
        r.grantSetterRoles(_textSetter(KEY_SPEND_CAP), user);
        r.grantSetterRoles(_textSetter(KEY_SLIPPAGE), user);
        r.grantSetterRoles(_textSetter(KEY_FIXTURE), user);

        // The platform keeps the history.
        r.grantSetterRoles(_textSetter(KEY_MATCHES_PLAYED), platform);
        r.grantSetterRoles(_textSetter(KEY_PNL_HISTORY), platform);
        r.grantSetterRoles(_textSetter(KEY_REVOKED_AT), platform);
    }

    /// @dev Only the selector and the key argument matter for resource derivation.
    function _textSetter(string memory key) private pure returns (bytes memory) {
        return abi.encodeWithSignature("setText(bytes,string,string)", "", key, "");
    }

    /// @notice Parent revokes the agent's mandate.
    /// @dev Unregistering the subname is the strongest form: status stops being
    ///      REGISTERED, so {isAuthorized} fails on its first check and any queued
    ///      order is cancelled on the next tick.
    function revokeAgent(address agent) external {
        AgentRecord storage rec = agentRecords[agent];
        if (!rec.exists) revert UnknownAgent();
        if (msg.sender != operator && msg.sender != rec.user) revert OnlyOperator();

        rec.registry.revokeRoles(rec.resource, AGENT_ROLE_BITMAP, agent);
        rec.registry.unregister(rec.tokenId);

        emit AgentRevoked(agent, rec.fqdn);
    }

    // ------------------------------------------------------------ IAgentAuth

    /// @inheritdoc IAgentAuth
    function isAuthorized(address agent, uint256 fixtureId, address, uint256 amountUSDC)
        external
        view
        returns (bool)
    {
        AgentRecord storage rec = agentRecords[agent];
        if (!rec.exists) return false;

        // 1. Does the name still exist? Revocation unregisters it.
        if (rec.registry.getStatus(rec.tokenId) != IPermissionedRegistry.Status.REGISTERED) {
            return false;
        }

        // 2. Has the mandate expired? Expiry is fixture full time + 5 minutes.
        if (rec.registry.getExpiry(rec.tokenId) <= block.timestamp) return false;

        // 3. Does the agent still hold its role on its own name?
        if (!rec.registry.hasRoles(rec.resource, AGENT_ROLE_BITMAP, agent)) return false;

        // 4. Is this the fixture the user scoped it to? Read from ENS, not storage.
        if (_readUint(rec, KEY_FIXTURE) != fixtureId) return false;

        // 5. Is there cap left? The cap is authoritative in ENS; the tally is local.
        uint256 cap = _readUint(rec, KEY_SPEND_CAP);
        if (rec.spentUSDC + amountUSDC > cap) return false;

        return true;
    }

    /// @inheritdoc IAgentAuth
    function isAgent(address account) external view returns (bool) {
        return agentRecords[account].exists;
    }

    /// @inheritdoc IAgentAuth
    function recordSpend(address agent, uint256 amountUSDC) external {
        AgentRecord storage rec = agentRecords[agent];
        if (!rec.exists) revert UnknownAgent();
        if (msg.sender != market) revert OnlyMarket();

        uint256 cap = _readUint(rec, KEY_SPEND_CAP);
        uint256 spent = rec.spentUSDC;
        if (spent + amountUSDC > cap) {
            revert SpendCapExceeded(amountUSDC, cap > spent ? cap - spent : 0);
        }

        rec.spentUSDC = spent + amountUSDC;
        emit SpendRecorded(agent, amountUSDC, rec.spentUSDC);
    }

    /// @notice The hook / market venue permitted to debit spend caps.
    address public market;

    function setMarket(address market_) external onlyOperator {
        market = market_;
    }

    // ----------------------------------------------------------------- views

    /// @dev Reads a text record straight off the agent's own resolver. `resolve` is
    ///      a plain view on the resolver instance, so this is a normal on-chain read
    ///      with no gateway involved.
    function readText(address agent, string memory key) public view returns (string memory) {
        return _readText(agentRecords[agent], key);
    }

    function _readText(AgentRecord storage rec, string memory key) private view returns (string memory) {
        bytes memory data = abi.encodeWithSelector(ITextResolverProfile.text.selector, rec.node, key);
        bytes memory result = IPermissionedResolver(rec.resolver).resolve(rec.dnsName, data);
        return abi.decode(result, (string));
    }

    function _readUint(AgentRecord storage rec, string memory key) private view returns (uint256) {
        return WhistleNames.parseUint(_readText(rec, key));
    }

    function agentInfo(address agent)
        external
        view
        returns (
            address user,
            address registry,
            address resolver,
            uint256 tokenId,
            uint256 fixtureId,
            uint256 templateId,
            uint256 spentUSDC,
            string memory fqdn
        )
    {
        AgentRecord storage rec = agentRecords[agent];
        return (
            rec.user,
            address(rec.registry),
            rec.resolver,
            rec.tokenId,
            rec.fixtureId,
            rec.templateId,
            rec.spentUSDC,
            rec.fqdn
        );
    }

    function agentCount() external view returns (uint256) {
        return allAgents.length;
    }

    function remainingCap(address agent) external view returns (uint256) {
        AgentRecord storage rec = agentRecords[agent];
        if (!rec.exists) return 0;
        uint256 cap = _readUint(rec, KEY_SPEND_CAP);
        return cap > rec.spentUSDC ? cap - rec.spentUSDC : 0;
    }

    // -------------------------------------------------------------- internal

    function _agentLabels(string memory agentLabel, string memory userLabel)
        private
        view
        returns (string[] memory labels)
    {
        uint256 n = rootLabels.length;
        labels = new string[](n + 2);
        labels[0] = agentLabel;
        labels[1] = userLabel;
        for (uint256 i = 0; i < n; ++i) {
            labels[i + 2] = rootLabels[i];
        }
    }

    function _fullRegistryRoles() private pure returns (uint256) {
        return EnsSepolia.ROLE_REGISTRAR | EnsSepolia.ROLE_REGISTRAR_ADMIN | EnsSepolia.ROLE_UNREGISTER
            | EnsSepolia.ROLE_UNREGISTER_ADMIN | EnsSepolia.ROLE_SET_SUBREGISTRY
            | EnsSepolia.ROLE_SET_SUBREGISTRY_ADMIN | EnsSepolia.ROLE_SET_RESOLVER
            | EnsSepolia.ROLE_SET_RESOLVER_ADMIN;
    }
}
