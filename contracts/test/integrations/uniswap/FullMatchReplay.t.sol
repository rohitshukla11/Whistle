// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Vm} from "forge-std/Vm.sol";
import {console} from "forge-std/console.sol";

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {PoolKey} from "v4-core/src/types/PoolKey.sol";

import {WhistleHookForkBase} from "./WhistleHookForkBase.sol";
import {WhistleHook} from "../../../src/integrations/uniswap/WhistleHook.sol";
import {AgentRegistry} from "../../../src/integrations/ens/AgentRegistry.sol";
import {IMatchOracle} from "../../../src/core/interfaces/IMatchOracle.sol";
import {IMarketVenue} from "../../../src/interfaces/IMarketVenue.sol";
import {ScoreMath} from "../../../src/core/libraries/ScoreMath.sol";

/// @notice The demo, end to end: a scripted 90-minute match driven through the real
///         stack on a Sepolia fork — real ENSv2, real PoolManager, real
///         PositionManager — from kickoff to the last redemption.
///
/// @dev This is the confidence test. Everything else checks one mechanism in
///      isolation; this checks that twenty-five events, six ENS-mandated agents,
///      eight human portfolios, a mid-match revocation and a paginated keeper loop
///      all survive contact with each other.
///
///      Squad: 7 per side — 5 starters and 2 substitutes, because a SUB has to bring
///      on somebody who is not already on the pitch. Three of the fourteen cards get
///      pools and are traded; the rest carry supply and move `D`.
contract FullMatchReplayTest is WhistleHookForkBase {
    // ------------------------------------------------------------- squad

    function _perSide() internal pure override returns (uint16) {
        return 7;
    }

    /// @dev 0 GK, 1 DEF, 2 MID, 3 FWD, 4 FWD starting; 5 MID, 6 FWD on the bench.
    function _configFor(uint8 team, uint16 i) internal pure override returns (ScoreMath.PlayerConfig memory) {
        bool starter = i < 5;
        ScoreMath.Position pos = i == 0
            ? ScoreMath.Position.GK
            : i == 1 ? ScoreMath.Position.DEF : (i == 2 || i == 5) ? ScoreMath.Position.MID : ScoreMath.Position.FWD;
        bool defensive = pos == ScoreMath.Position.GK || pos == ScoreMath.Position.DEF;

        return ScoreMath.PlayerConfig({
            expectedEventPoints: pos == ScoreMath.Position.FWD
                ? uint128(3e18)
                : pos == ScoreMath.Position.MID ? uint128(2e18) : pos == ScoreMath.Position.DEF ? uint128(1e18) : uint128(0.5e18),
            cleanSheetProb0: defensive ? uint64(0.3e18) : uint64(0),
            expectedMinutes: starter ? 90 : 25,
            team: team,
            position: pos,
            starter: starter
        });
    }

    // ------------------------------------------------------------- state

    uint16 internal constant KEEPER_PAGE = 5;
    uint16 internal constant SECONDS_PER_STEP = 45;

    /// @dev Team 0 keeper, team 0 striker, team 1 striker.
    uint16[3] internal TRADED = [uint16(0), 3, 10];
    address[3] internal tradedCards;

    address[8] internal wallets;
    address[6] internal agents;
    /// @dev 1 = protect, 2 = momentum, 3 = contrarian. Two of each.
    uint8[6] internal templates = [1, 1, 2, 2, 3, 3];

    struct MatchEvent {
        uint16 minute;
        IMatchOracle.EventType kind;
        uint16 a;
        uint16 b;
    }

    MatchEvent[] internal script;

    struct GasPhases {
        uint256 setup;
        uint256 agents;
        uint256 kickoff;
        uint256 events;
        uint256 queueing;
        uint256 ticks;
        uint256 settle;
        uint256 redeem;
        uint256 orders;
        uint256 tickCalls;
        uint256 fills;
        uint256 cancels;
    }

    GasPhases internal g;

    /// @dev The agent whose mandate is pulled mid-match, and its pending order.
    uint256 internal revokedAgentIndex = 4;
    uint256 internal revokedOrderId;
    bool internal revokeDone;

    // ------------------------------------------------------------- setup

    function setUp() public {
        if (!_setUpFork()) return;

        uint256 start = gasleft();
        _setUpRigPreMatch();
        _addTradedPools();
        _createDemoWallets();
        g.setup = start - gasleft();

        start = gasleft();
        _createAgents();
        g.agents = start - gasleft();

        _buildScript();
    }

    /// @dev The base rig pools and seeds `cards(0)`. Two more get the same treatment
    ///      so the match has a keeper and a striker on each side to trade.
    function _addTradedPools() private {
        tradedCards[0] = card;
        for (uint256 i = 1; i < TRADED.length; ++i) {
            address c = pot.cards(TRADED[i]);
            tradedCards[i] = c;
            _createPoolFor(c);

            // This contract is the deployer and distributor: it briefly holds the
            // whole float before handing portfolios out, so it is exempt. The
            // wallets and agents it hands them to are NOT.
            factory.setCapExempt(c, address(this), true);
            pot.mintPreMatch(c, 20_000e18, address(this));
            vault.seedCard(c, LP_SHARE_BPS, 5_000e6);

            IERC20(c).approve(address(vault), type(uint256).max);
            vault.depositCards(c, 5_000e18);
        }
        // Supply on the untraded cards too, so `D` reflects a whole squad.
        for (uint16 p = 0; p < _perSide() * 2; ++p) {
            address c = pot.cards(p);
            if (_isTraded(c)) continue;
            factory.setCapExempt(c, address(this), true);
            pot.mintPreMatch(c, 5_000e18, address(this));
        }
    }

    /// @dev Eight humans, each with a different book. Portfolios are small against a
    ///      20k+ supply, so the 5% holder cap never binds and nobody is exempted —
    ///      the cap has to stay live for this to be a realistic run.
    function _createDemoWallets() private {
        for (uint256 i = 0; i < wallets.length; ++i) {
            address w = _eoa(string.concat("wallet", vm.toString(i)));
            wallets[i] = w;

            usdc.mint(w, 500_000e6);
            vm.startPrank(w);
            usdc.approve(address(hook), type(uint256).max);
            for (uint256 c = 0; c < tradedCards.length; ++c) {
                IERC20(tradedCards[c]).approve(address(hook), type(uint256).max);
            }
            vm.stopPrank();

            // Distinct books: wallet i is heavy in card i % 3 and lighter elsewhere.
            for (uint256 c = 0; c < tradedCards.length; ++c) {
                uint256 units = (c == i % 3 ? 400e18 : 80e18) + (i * 10e18);
                IERC20(tradedCards[c]).transfer(w, units);
            }
        }
    }

    function _createAgents() private {
        uint64 expiry = uint64(block.timestamp + 6 hours);

        for (uint256 i = 0; i < agents.length; ++i) {
            address a = _eoa(string.concat("replayAgent", vm.toString(i)));
            agents[i] = a;

            agentRegistry.createAgent(
                AgentRegistry.CreateAgentParams({
                    user: user,
                    agent: a,
                    fixtureId: FIXTURE_ID,
                    templateId: templates[i],
                    spendCapUSDC: 2_000_000e6,
                    slippageBps: 1000,
                    expiry: expiry,
                    salt: 100 + i
                })
            );

            usdc.mint(a, 500_000e6);
            vm.startPrank(a);
            usdc.approve(address(hook), type(uint256).max);
            for (uint256 c = 0; c < tradedCards.length; ++c) {
                IERC20(tradedCards[c]).approve(address(hook), type(uint256).max);
            }
            vm.stopPrank();

            for (uint256 c = 0; c < tradedCards.length; ++c) {
                IERC20(tradedCards[c]).transfer(a, 300e18);
            }
        }
    }

    /// @dev Twenty-five events: heartbeats every few minutes, two substitutions, a
    ///      red card, and a goal at each end with the second one late.
    function _buildScript() private {
        uint16[14] memory hbMinutes = [uint16(2), 5, 8, 12, 15, 18, 22, 25, 35, 40, 50, 55, 65, 70];
        for (uint256 i = 0; i < hbMinutes.length; ++i) {
            script.push(MatchEvent(hbMinutes[i], IMatchOracle.EventType.HEARTBEAT, 0, 0));
        }
        // Order matters: the oracle clock is monotonic, so the script is sorted below.
        script.push(MatchEvent(30, IMatchOracle.EventType.SUB, 2, 5)); // team 0 midfield
        script.push(MatchEvent(45, IMatchOracle.EventType.GOAL, 3, 0)); // team 0 striker scores
        script.push(MatchEvent(60, IMatchOracle.EventType.RED, 8, 0)); // team 1 defender off
        script.push(MatchEvent(72, IMatchOracle.EventType.SUB, 9, 12)); // team 1 midfield
        script.push(MatchEvent(88, IMatchOracle.EventType.GOAL, 10, 0)); // late equaliser
        script.push(MatchEvent(75, IMatchOracle.EventType.HEARTBEAT, 0, 0));
        script.push(MatchEvent(80, IMatchOracle.EventType.HEARTBEAT, 0, 0));
        script.push(MatchEvent(85, IMatchOracle.EventType.HEARTBEAT, 0, 0));
        script.push(MatchEvent(90, IMatchOracle.EventType.HEARTBEAT, 0, 0));
        script.push(MatchEvent(28, IMatchOracle.EventType.HEARTBEAT, 0, 0));
        script.push(MatchEvent(58, IMatchOracle.EventType.HEARTBEAT, 0, 0));

        _sortScript();
    }

    function _sortScript() private {
        for (uint256 i = 1; i < script.length; ++i) {
            MatchEvent memory key = script[i];
            uint256 j = i;
            while (j > 0 && script[j - 1].minute > key.minute) {
                script[j] = script[j - 1];
                --j;
            }
            script[j] = key;
        }
    }

    // -------------------------------------------------------------- the run

    function test_FullMatchReplay() public onlyForked {
        uint256 matchGasStart = gasleft();

        uint256 start = gasleft();
        _kickoff();
        g.kickoff = start - gasleft();

        uint256 potAfterKickoff = pot.potBalance();

        for (uint256 i = 0; i < script.length; ++i) {
            _runStep(i);
        }

        // Everything still queued clears before the whistle.
        vm.warp(block.timestamp + 120);
        _runKeeper();

        start = gasleft();
        uint256[] memory noExpected = new uint256[](0);
        vm.prank(oracleSigner);
        oracle.postFinal(FIXTURE_ID, noExpected);
        g.settle = start - gasleft();

        assertTrue(pot.settled(), "fixture did not settle");
        assertEq(uint256(oracle.fixtureState(FIXTURE_ID)), 2, "fixture is not SETTLED");

        uint256 snapshotPot = pot.potSnapshot();
        assertGt(snapshotPot, 0, "settlement snapshot is empty");

        _redeemEverything();

        uint256 totalMatchGas = matchGasStart - gasleft();

        _assertPotDrainedToDust();
        _assertVaultReconciles();
        _assertRevokedAgentIsShutOut();

        _report(totalMatchGas, potAfterKickoff, snapshotPot);
    }

    /// @dev One scripted event: react, post, wait out `L`, then run the keeper.
    function _runStep(uint256 i) private {
        MatchEvent memory e = script[i];

        vm.warp(block.timestamp + SECONDS_PER_STEP);

        uint256 start = gasleft();
        _postEvent(e);
        g.events += start - gasleft();

        start = gasleft();
        _react(i, e);
        g.queueing += start - gasleft();

        // The mandate is pulled while that agent still has an order in the book.
        if (i == script.length / 2 && !revokeDone) {
            revokeDone = true;
            vm.prank(user);
            agentRegistry.revokeAgent(agents[revokedAgentIndex]);
        }

        // Past the order delay, so this step's orders are eligible.
        vm.warp(block.timestamp + ORDER_DELAY_L + 5);
        _runKeeper();
    }

    function _postEvent(MatchEvent memory e) private {
        uint16[] memory ids;
        if (e.kind == IMatchOracle.EventType.SUB) {
            ids = new uint16[](2);
            ids[0] = e.a;
            ids[1] = e.b;
        } else if (e.kind != IMatchOracle.EventType.HEARTBEAT) {
            ids = new uint16[](1);
            ids[0] = e.a;
        } else {
            ids = new uint16[](0);
        }

        uint64 ts = uint64(block.timestamp);
        vm.prank(oracleSigner);
        oracle.postEvent(FIXTURE_ID, e.minute, e.kind, ids, ts);
    }

    /// @dev Agents and humans react. The templates are crude on purpose — the point
    ///      is that six ENS-mandated addresses and eight unmandated ones are both
    ///      putting orders into the same book while the oracle moves the price.
    function _react(uint256 step, MatchEvent memory e) private {
        bool bigEvent = e.kind != IMatchOracle.EventType.HEARTBEAT;

        for (uint256 i = 0; i < agents.length; ++i) {
            if (revokeDone && i == revokedAgentIndex) continue;

            address a = agents[i];
            address c = tradedCards[(step + i) % tradedCards.length];
            uint8 tpl = templates[i];

            // protect sells into news, momentum buys it, contrarian fades it.
            bool buy = tpl == 1 ? false : tpl == 2 ? bigEvent : !bigEvent;
            if (tpl == 1 && !bigEvent) continue; // protect only acts on news

            uint256 units = bigEvent ? 60e18 : 25e18;
            uint256 id = _tryQueue(a, c, buy ? IMarketVenue.Side.BUY : IMarketVenue.Side.SELL, units, 1000);

            // Keep hold of one live order from the agent that is about to be revoked.
            if (!revokeDone && i == revokedAgentIndex && id != 0) revokedOrderId = id;
        }

        for (uint256 i = 0; i < wallets.length; ++i) {
            if ((step + i) % 3 != 0) continue; // not everybody trades every minute
            address w = wallets[i];
            address c = tradedCards[(step + i) % tradedCards.length];
            bool buy = (step + i) % 2 == 0;
            _tryQueue(w, c, buy ? IMarketVenue.Side.BUY : IMarketVenue.Side.SELL, 20e18, 500);
        }
    }

    /// @dev Queue, tolerating the refusals a live book legitimately produces: a
    ///      revoked mandate, or a position that would breach the holder cap.
    function _tryQueue(address who, address c, IMarketVenue.Side side, uint256 units, uint16 slippageBps)
        private
        returns (uint256 orderId)
    {
        vm.prank(who);
        try hook.queueOrder(FIXTURE_ID, c, side, units, slippageBps, false) returns (uint256 id) {
            ++g.orders;
            return id;
        } catch {
            return 0;
        }
    }

    /// @dev The keeper loop: paginated `tick`, five orders at a time, until a call
    ///      resolves nothing. Every call is checked for uniform pricing.
    function _runKeeper() private {
        for (uint256 round = 0; round < 40; ++round) {
            vm.recordLogs();
            uint256 start = gasleft();
            vm.prank(keeper);
            (, uint256 processed) = hook.tick(FIXTURE_ID, TICK_CARDS, KEEPER_PAGE);
            g.ticks += start - gasleft();
            ++g.tickCalls;

            _assertTickUniformPerCard(vm.getRecordedLogs());

            if (processed == 0) return;
        }
        revert("keeper did not converge");
    }

    // -------------------------------------------------------- assertions

    /// @dev Within one `tick` call, every fill of a given card must be at one price.
    ///      Different cards clear at their own `R`, so grouping is by card.
    function _assertTickUniformPerCard(Vm.Log[] memory logs) private {
        bytes32 filled = keccak256("OrderFilled(uint256,address,uint256,uint256,uint256)");
        bytes32 cancelled = keccak256("OrderCancelled(uint256,uint8)");

        address[8] memory seenCard;
        uint256[8] memory seenPrice;
        uint256 n;

        for (uint256 i = 0; i < logs.length; ++i) {
            if (logs[i].topics.length == 0) continue;

            if (logs[i].topics[0] == cancelled) {
                ++g.cancels;
                continue;
            }
            if (logs[i].topics[0] != filled || logs[i].topics.length < 3) continue;

            ++g.fills;
            address c = address(uint160(uint256(logs[i].topics[2])));
            (uint256 units, uint256 usdcAmount, uint256 price) =
                abi.decode(logs[i].data, (uint256, uint256, uint256));

            assertEq(usdcAmount, Math.mulDiv(price, units, WAD), "notional is not units * price");

            bool found;
            for (uint256 k = 0; k < n; ++k) {
                if (seenCard[k] != c) continue;
                assertEq(price, seenPrice[k], "two prices for one card inside one tick");
                found = true;
                break;
            }
            if (!found && n < seenCard.length) {
                seenCard[n] = c;
                seenPrice[n] = price;
                ++n;
            }
        }
    }

    /// @dev Everyone redeems everything, so the pot has nothing legitimately left.
    function _redeemEverything() private {
        uint256 start = gasleft();

        for (uint256 c = 0; c < tradedCards.length; ++c) {
            vault.closeCard(tradedCards[c]);
        }
        vault.closeReserve();

        uint16 total = _perSide() * 2;
        for (uint16 p = 0; p < total; ++p) {
            address c = pot.cards(p);
            _redeemFrom(c, address(this));
            _redeemFrom(c, address(vault));
            _redeemFrom(c, address(hook));
            // The base rig's own actors hold pre-match positions too, and the pot
            // cannot drain while anybody's units are still outstanding.
            _redeemFrom(c, agentA);
            _redeemFrom(c, agentB);
            _redeemFrom(c, human);
            for (uint256 i = 0; i < wallets.length; ++i) {
                _redeemFrom(c, wallets[i]);
            }
            for (uint256 i = 0; i < agents.length; ++i) {
                _redeemFrom(c, agents[i]);
            }
        }

        g.redeem = start - gasleft();

        // Diagnostic: anything still outstanding keeps its share of the pot locked.
        uint16 n = _perSide() * 2;
        for (uint16 p = 0; p < n; ++p) {
            address c = pot.cards(p);
            // A few wei per pooled card stay stranded inside the PoolManager as
            // liquidity-math rounding. Anything larger means a holder was missed.
            uint256 left = IERC20(c).totalSupply();
            if (left > 1e12) {
                console.log("UNREDEEMED card", p, left);
                console.log("   finalScore", pot.finalScoreOf(c));
            }
        }
    }

    function _redeemFrom(address c, address holder) private {
        uint256 bal = IERC20(c).balanceOf(holder);
        if (bal == 0) return;
        vm.prank(holder);
        pot.redeem(c, bal, holder);
    }

    function _assertPotDrainedToDust() private view {
        uint256 left = pot.potBalance();
        uint256 snapshot = pot.potSnapshot();

        // Two sources of residue, both genuinely dust:
        //   - every redemption rounds its payout down by at most one unit of USDC;
        //   - a few wei of card units stay stranded in the PoolManager as liquidity
        //     rounding, and nothing can redeem those because the PoolManager cannot
        //     call `redeem`.
        // Bound it relatively rather than trying to predict the exact wei.
        assertLt(Math.mulDiv(left, 1e9, snapshot), 1e4, "pot did not drain to dust (>0.001% left)");
    }

    function _assertVaultReconciles() private view {
        for (uint256 c = 0; c < tradedCards.length; ++c) {
            address t = tradedCards[c];
            (uint256 cardClaims, uint256 usdcClaims) = vault.claimBalances(t);
            assertEq(vault.cardInventory(t), cardClaims, "vault card inventory drifted from its claims");
            assertEq(vault.availableUSDC(), usdcClaims, "vault reserve drifted from its claims");
            assertEq(vault.cardInventory(t), 0, "vault still holds inventory after close out");
            assertEq(IERC20(t).balanceOf(address(vault)), 0, "vault still holds cards after close out");
        }

        (int256 pnl, uint256 fees,,) = vault.vaultPnL();
        assertGt(fees, 0, "vault earned no fees across a whole match");
        assertEq(
            pnl,
            int256(usdc.balanceOf(address(vault))) - int256(vault.capitalIn()),
            "pnl does not reconcile with cash less capital"
        );
    }

    function _assertRevokedAgentIsShutOut() private {
        assertTrue(revokeDone, "the scripted revocation never happened");
        assertGt(revokedOrderId, 0, "the revoked agent never had a live order");

        WhistleHook.Order memory o = hook.getOrder(revokedOrderId);
        assertEq(uint256(o.status), uint256(WhistleHook.Status.CANCELLED), "pending order survived revocation");
        assertEq(o.filled, 0, "revoked order filled anyway");

        // Settled now, so the queue is shut for everyone; the point is that the
        // revoked agent was refused while the match was still live, which
        // {test_RevokedAgentCannotQueueAgainMidMatch} pins down separately.
        assertFalse(agentRegistry.isAuthorized(agents[revokedAgentIndex], FIXTURE_ID, card, 1), "still authorized");
    }

    function _report(uint256 totalMatchGas, uint256 potAfterKickoff, uint256 snapshotPot) private view {
        console.log("=== Whistle full-match replay ===");
        console.log("events posted        ", script.length);
        console.log("orders queued        ", g.orders);
        console.log("tick calls (paginated)", g.tickCalls);
        console.log("fills                ", g.fills);
        console.log("cancellations        ", g.cancels);
        console.log("");
        console.log("--- gas by phase ---");
        console.log("setup + seeding      ", g.setup);
        console.log("agent creation (ENS) ", g.agents);
        console.log("kickoff              ", g.kickoff);
        console.log("event posting        ", g.events);
        console.log("order queueing       ", g.queueing);
        console.log("keeper ticks         ", g.ticks);
        console.log("postFinal            ", g.settle);
        console.log("redemption           ", g.redeem);
        console.log("TOTAL match gas      ", totalMatchGas);
        console.log("");
        console.log("--- pot ---");
        console.log("after kickoff        ", potAfterKickoff);
        console.log("settlement snapshot  ", snapshotPot);
        console.log("residue after redeem ", pot.potBalance());
    }

    // ------------------------------------------------------ gas model checks

    /// @notice Four orders, all on ONE card.
    function test_Gas_TickOneCard() public onlyForked {
        _kickoff();
        _queueN(tradedCards[0], 4);
        console.log("tick gas, 4 orders on 1 card ", _tickOnce());
    }

    /// @notice Twelve orders, still one card, to isolate the marginal per-order cost
    ///         in the same rig as the per-card measurement above.
    function test_Gas_TickTwelveOnOneCard() public onlyForked {
        _kickoff();
        _queueN(tradedCards[0], 12);
        console.log("tick gas, 12 orders on 1 card", _tickOnce());
    }

    /// @notice The same four orders, spread across TWO cards.
    /// @dev The delta between this and the test above is the real per-card cost of a
    ///      tick: `_clearCard` does its own reference-price read, fee computation,
    ///      rationing and residual swap for every distinct card in the batch.
    function test_Gas_TickTwoCards() public onlyForked {
        _kickoff();
        _queueN(tradedCards[0], 2);
        _queueN(tradedCards[1], 2);
        console.log("tick gas, 4 orders on 2 cards", _tickOnce());
    }

    /// @notice And three, to confirm the per-card cost is linear.
    function test_Gas_TickThreeCards() public onlyForked {
        _kickoff();
        _queueN(tradedCards[0], 2);
        _queueN(tradedCards[1], 2);
        _queueN(tradedCards[2], 2);
        console.log("tick gas, 6 orders on 3 cards", _tickOnce());
    }

    /// @notice Four orders on one card, all the same way, so the book does NOT net
    ///         and the vault has to be drawn on through the router.
    /// @dev The delta against {test_Gas_TickOneCard} — same card, same order count,
    ///      but a balanced book there — is the cost of the residual swap itself.
    function test_Gas_TickOneCardUnbalanced() public onlyForked {
        _kickoff();
        _queueOneSided(tradedCards[0], 4, IMarketVenue.Side.BUY);
        console.log("tick gas, 4 buys on 1 card   ", _tickOnce());
    }

    function _queueOneSided(address c, uint256 n, IMarketVenue.Side side) private {
        for (uint256 i = 0; i < n; ++i) {
            address w = wallets[i % wallets.length];
            vm.prank(w);
            hook.queueOrder(FIXTURE_ID, c, side, 20e18, 500, false);
        }
    }

    function _queueN(address c, uint256 n) private {
        for (uint256 i = 0; i < n; ++i) {
            address w = wallets[i % wallets.length];
            vm.prank(w);
            hook.queueOrder(
                FIXTURE_ID, c, i % 2 == 0 ? IMarketVenue.Side.BUY : IMarketVenue.Side.SELL, 20e18, 500, false
            );
        }
    }

    function _tickOnce() private returns (uint256 gasUsed) {
        vm.warp(block.timestamp + ORDER_DELAY_L + 5);
        vm.prank(keeper);
        uint256 start = gasleft();
        hook.tick(FIXTURE_ID, TICK_CARDS, 50);
        gasUsed = start - gasleft();
    }

    // -------------------------------------------------------- focused checks

    /// @notice The revoked agent is refused at the door, mid-match, not merely at the
    ///         next tick. Kept separate so it asserts against a LIVE fixture.
    function test_RevokedAgentCannotQueueAgainMidMatch() public onlyForked {
        _kickoff();

        address a = agents[revokedAgentIndex];
        vm.warp(block.timestamp + 30);

        vm.prank(a);
        uint256 id = hook.queueOrder(FIXTURE_ID, card, IMarketVenue.Side.BUY, 10e18, 1000, false);
        assertGt(id, 0, "agent could not queue before revocation");

        vm.prank(user);
        agentRegistry.revokeAgent(a);

        vm.prank(a);
        vm.expectRevert(WhistleHook.Unauthorized.selector);
        hook.queueOrder(FIXTURE_ID, card, IMarketVenue.Side.BUY, 10e18, 1000, false);

        // And the order already in the book dies with reason REVOKED.
        vm.warp(block.timestamp + ORDER_DELAY_L + 5);
        vm.recordLogs();
        vm.prank(keeper);
        hook.tick(FIXTURE_ID, TICK_CARDS, KEEPER_PAGE);

        assertEq(
            uint256(_cancelReasonOf(vm.getRecordedLogs(), id)),
            uint256(IMarketVenue.CancelReason.REVOKED),
            "pending order did not cancel as REVOKED"
        );
    }

    function _cancelReasonOf(Vm.Log[] memory logs, uint256 orderId)
        private
        pure
        returns (IMarketVenue.CancelReason)
    {
        bytes32 sig = keccak256("OrderCancelled(uint256,uint8)");
        for (uint256 i = 0; i < logs.length; ++i) {
            if (logs[i].topics.length < 2 || logs[i].topics[0] != sig) continue;
            if (uint256(logs[i].topics[1]) != orderId) continue;
            return IMarketVenue.CancelReason(abi.decode(logs[i].data, (uint8)));
        }
        revert("no cancellation for that order");
    }

    function _isTraded(address c) private view returns (bool) {
        for (uint256 i = 0; i < tradedCards.length; ++i) {
            if (tradedCards[i] == c) return true;
        }
        return false;
    }
}
