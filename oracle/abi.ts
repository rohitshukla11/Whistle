/**
 * Human-readable ABIs for the contracts the off-chain code touches.
 *
 * Written by hand rather than imported from `contracts/out`, so the TypeScript
 * builds without a prior `forge build` and the surface actually used is visible in
 * one file. `pnpm typecheck` will not catch a signature that drifts from Solidity —
 * the Foundry fork tests are what pin those down.
 */

import { parseAbi } from "viem";

export const matchOracleAbi = parseAbi([
  "function createFixture(uint256 fixtureId, address pot, uint32 orderDelayL, uint32 staleTolerance)",
  "function kickoff(uint256 fixtureId)",
  "function postEvent(uint256 fixtureId, uint16 minute, uint8 eventType, uint16[] playerIds, uint64 sourceTimestamp)",
  "function postFinal(uint256 fixtureId, uint256[] expectedS)",
  "function matchClock(uint256 fixtureId) view returns (uint16)",
  "function fixtureState(uint256 fixtureId) view returns (uint8)",
  "function playerCount(uint256 fixtureId) view returns (uint16)",
  "function cardOf(uint256 fixtureId, uint16 playerId) view returns (address)",
  "function expectedScore(uint256 fixtureId, uint16 playerId) view returns (uint256)",
  "function finalScore(uint256 fixtureId, uint16 playerId) view returns (uint256)",
  "function minutesPlayed(uint256 fixtureId, uint16 playerId) view returns (uint16)",
  "function playerConfig(uint256 fixtureId, uint16 playerId) view returns ((uint128 expectedEventPoints, uint64 cleanSheetProb0, uint16 expectedMinutes, uint8 team, uint8 position, bool starter))",
  "function playerState(uint256 fixtureId, uint16 playerId) view returns ((int128 banked, uint16 entryMinute, uint16 frozenMinutes, bool onPitch, bool frozen))",
  "function fixtures(uint256 fixtureId) view returns (address pot, uint8 state, uint16 clock, uint16 playerCount, uint32 orderDelayL, uint32 staleTolerance, uint64 lastEventAt, bool team0Conceded, bool team1Conceded, bool finalized)",
  "event KickedOff(uint256 indexed fixtureId, uint64 at)",
  "event MatchEvent(uint256 indexed fixtureId, uint16 minute, uint8 eventType, uint16[] playerIds, uint64 sourceTimestamp)",
  "event Settled(uint256 indexed fixtureId, uint16 clock)",
  "error WrongState()",
  "error NotAuthorized()",
  "error NonMonotonicMinute(uint16 given, uint16 clock)",
  "error StaleEvent(uint64 sourceTimestamp, uint64 nowTs, uint32 maxLag)",
  "error FutureEvent(uint64 sourceTimestamp, uint64 nowTs)",
  "error BadPlayerCount()",
  "error PlayerFrozen(uint16 playerId)",
  "error PlayerNotOnPitch(uint16 playerId)",
  "error PlayerAlreadyOnPitch(uint16 playerId)",
  "error FinalScoreMismatch(uint16 playerId, uint256 computed, uint256 expected)",
  "error PlayersNotFinalized()",
]);

export const settlementPotAbi = parseAbi([
  "function usdc() view returns (address)",
  "function referencePrice(address card) view returns (uint256)",
  "function preMatchPrice(address card) view returns (uint256)",
  "function payoutPerUnit(address card) view returns (uint256)",
  "function quoteMint(address card, uint256 units) view returns (uint256)",
  "function quoteAtReference(address card, uint256 units) view returns (uint256)",
  "function mintPreMatch(address card, uint256 units, address to) returns (uint256)",
  "function redeem(address card, uint256 units, address to) returns (uint256)",
  "function potBalance() view returns (uint256)",
  "function potSnapshot() view returns (uint256)",
  "function settled() view returns (bool)",
  "function cards(uint256 index) view returns (address)",
  "function cardCount() view returns (uint256)",
  "function supplyOf(address card) view returns (uint256)",
  "event Minted(address indexed card, address indexed to, uint256 units, uint256 costUSDC)",
  "event Redeemed(address indexed card, address indexed from, uint256 units, uint256 payoutUSDC)",
  // Raised by the card during a mint, bubbled through the pot: named here so a
  // refused pre-match mint reads as the rule it broke, not a bare signature.
  "error HolderCapExceeded(address holder, uint256 balance, uint256 maxAllowed)",
]);

export const whistleHookAbi = parseAbi([
  "function queueOrder(uint256 fixtureId, address card, uint8 side, uint256 amount, uint16 maxSlippageBps, bool isMint) returns (uint256 orderId)",
  "function tick(uint256 fixtureId, uint256 maxCards, uint256 maxOrdersPerCard) returns (uint256 nextCursor, uint256 processed)",
  "function cancelOrder(uint256 orderId)",
  "function queueLength(uint256 fixtureId) view returns (uint256)",
  "function queueHead(uint256 fixtureId) view returns (uint256)",
  "function currentFeeBps(uint256 fixtureId, address card) view returns (uint24)",
  "function vaultCardUnits(address card) view returns (uint256)",
  "function accruedFeesUSDC() view returns (uint256)",
  "event OrderQueued(uint256 indexed orderId, uint256 indexed fixtureId, address indexed card, address owner, uint8 side, uint256 amount)",
  "event OrderFilled(uint256 indexed orderId, address indexed card, uint256 units, uint256 usdc, uint256 referencePrice)",
  "event OrderCancelled(uint256 indexed orderId, uint8 reason)",
  "event BatchCleared(address indexed card, uint256 referencePrice, uint256 buyVolume, uint256 sellVolume, int256 vaultResidual)",
  "function cardInfo(address card) view returns ((uint256 fixtureId, (address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) key, bool registered, bool usdcIsCurrency0))",
  // Custom errors. Without these viem cannot name a revert, and the runtime cannot
  // tell "your mandate does not cover this" from "that card has no pool" — which is
  // the difference between standing down and fixing a bug.
  "error Unauthorized()",
  "error WouldExceedHolderCap()",
  "error NotLive()",
  "error UnknownCard()",
  "error FixtureMismatch()",
  "error ZeroAmount()",
  "error AmountTooLarge()",
  "error SlippageTooHigh()",
  "error MintOrdersMustBeBuys()",
  "error PageTooLarge()",
  "error NotOrderOwner()",
  "error OrderNotPending()",
  "error DirectSwapDuringLive()",
]);

export const agentRegistryAbi = parseAbi([
  "function isAuthorized(address agent, uint256 fixtureId, address card, uint256 amountUSDC) view returns (bool)",
  "function isAgent(address account) view returns (bool)",
  "function remainingCap(address agent) view returns (uint256)",
  "function readText(address agent, string key) view returns (string)",
  "function agentInfo(address agent) view returns (address user, address registry, address resolver, uint256 tokenId, uint256 fixtureId, uint256 templateId, uint256 spentUSDC, string fqdn)",
  "function revokeAgent(address agent)",
  // One market at a time: the hook allowed to record agent spend. Each fixture
  // deploy repoints it, so a demo must be activated before its agents can trade.
  "function market() view returns (address)",
  "function setMarket(address market_)",
  "function operator() view returns (address)",
  "function agentCount() view returns (uint256)",
  "function allAgents(uint256 index) view returns (address)",
  "function createAgent((address user, address agent, uint256 fixtureId, uint256 templateId, uint256 spendCapUSDC, uint256 slippageBps, uint64 expiry, uint256 salt) p) returns (address resolver, uint256 tokenId)",
  "function registerUser(string label, address user, uint256 salt, uint64 expiry) returns (address registry, uint256 tokenId)",
  "function userAccounts(address user) view returns (address registry, string label, uint32 agentCount, bool exists)",
  "error UnknownAgent()",
  "error OnlyOperator()",
  "error SpendCapExceeded(uint256 requested, uint256 remaining)",
]);

/** The per-agent Permissioned Resolver. `name` is DNS-encoded, not a namehash. */
export const permissionedResolverAbi = parseAbi([
  "function setText(bytes name, string key, string value)",
  "function resolve(bytes name, bytes data) view returns (bytes)",
]);

export const erc20Abi = parseAbi([
  "function balanceOf(address account) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function transfer(address to, uint256 amount) returns (bool)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function totalSupply() view returns (uint256)",
]);

/** The demo quote asset. Open mint, which is what makes the demo self-serve. */
export const mockUsdcAbi = parseAbi([
  "function mint(address to, uint256 amount)",
  "function balanceOf(address account) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function transfer(address to, uint256 amount) returns (bool)",
  "function decimals() view returns (uint8)",
]);

export const playerCardAbi = parseAbi([
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function balanceOf(address account) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function transfer(address to, uint256 amount) returns (bool)",
  "function totalSupply() view returns (uint256)",
  "function capExempt(address account) view returns (bool)",
  "function MAX_HOLDER_BPS() view returns (uint256)",
]);

export const mmVaultAbi = parseAbi([
  "function cardState(address card) view returns ((uint128 inventory, uint128 seeded, uint256 positionId, (address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) key, bool registered, bool closed))",
  "function cardInventory(address card) view returns (uint256)",
  "function availableUSDC() view returns (uint256)",
  "function availableCardUnits(address card) view returns (uint256)",
  "function capitalIn() view returns (uint256)",
  "function feesEarned() view returns (uint256)",
  "function vaultPnL() view returns (int256 pnl, uint256 feesEarned, int256 marketMakingPnL, uint256 inventoryValue)",
  "function closeCard(address card) returns (uint256)",
  "function closeReserve()",
  "error NotSettled()",
  "error AlreadyClosed()",
  "error OnlyOperator()",
]);

// --------------------------------------------------------------- deploy-side

/**
 * The write surface the one-command deploy needs and nothing else touches.
 *
 * Kept apart from the read ABIs above because these are operator-only calls: if
 * anything here is reachable from the app or the agent runtime, that is a bug.
 */
export const fixtureFactoryAbi = parseAbi([
  "function setCapExempt(address card, address account, bool exempt)",
  "function fixtureState(uint256 fixtureId) view returns (uint8)",
  "function cardImplementation() view returns (address)",
]);

export const mmVaultWriteAbi = parseAbi([
  "function registerCard(address card, (address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) key)",
  "function seedCard(address card, uint16 lpShareBps, uint256 usdcForLp) returns (uint256 positionId)",
  "function depositCards(address card, uint256 units)",
  "function fund(uint256 amount)",
  "function fundReserve(uint256 amount)",
  "function SEED_UNITS() view returns (uint256)",
]);

export const whistleHookWriteAbi = parseAbi([
  "function registerCard(uint256 fixtureId, address card, (address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) key)",
]);

export const poolManagerAbi = parseAbi([
  "function initialize((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) key, uint160 sqrtPriceX96) returns (int24 tick)",
]);
