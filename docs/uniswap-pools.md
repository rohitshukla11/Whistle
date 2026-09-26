# Uniswap v4 pools

Every pooled player card trades in its own Uniswap v4 pool on Sepolia: the card against wUSDC
(`0x7f46405B3757523c3B30C0bb06585bBa16619490`), dynamic fee, tick spacing 60, and the fixture's
`WhistleHook`. The pool id is `keccak256(abi.encode(PoolKey))`, exactly as `PoolManager` computes it — the key is built in
[`DeployWhistle.s.sol:383-397`](../contracts/script/DeployWhistle.s.sol#L383-L397), where each pool is initialised. Every id below was checked
initialised on chain (`StateView.getSlot0`, non-zero price) when this file was generated.

Before kick-off the pools are open to direct swaps; during a live match the hook reverts them
(`DirectSwapDuringLive`) and trades go through Whistle's queue, filled at the oracle's reference price.
Uniswap's web app shows these pools and their liquidity, but its router returns no quote for them
("This trade cannot be completed right now"), so a direct swap has to be sent to a v4 router yourself.

## Demo 1 (`2026092701`) — hook [`0x4b7373E4512C45Dff92b1c4a6048Cd3240218088`](https://sepolia.etherscan.io/address/0x4b7373E4512C45Dff92b1c4a6048Cd3240218088)

| # | Player | Card | Pool |
|---|---|---|---|
| 0 | Petr Cech | [`W0PC`](https://sepolia.etherscan.io/token/0xFE6f07d9a82d11068BDDaCAA9B5D56B76c3B7dFE) | [`0x5005c7b4…a536`](https://app.uniswap.org/explore/pools/ethereum_sepolia/0x5005c7b49c608bb32fbf5dea21005ac4deaf6c8cbcb11f5c24aaf237077da536) |
| 5 | Michael Essien | [`W5ME`](https://sepolia.etherscan.io/token/0xdbdA1A465A91cCECee3eb1f8572dD7f6790d7087) | [`0xc57a3d37…7474`](https://app.uniswap.org/explore/pools/ethereum_sepolia/0xc57a3d37277ba8400c1cdffcbdab70e25dfeb7a10d62596522218b89a81f7474) |
| 9 | Florent Malouda | [`W9FM`](https://sepolia.etherscan.io/token/0x30E0BDdd073aDA924a69d0248A3B4859752e87d6) | [`0x2268a435…8c26`](https://app.uniswap.org/explore/pools/ethereum_sepolia/0x2268a43504d56b9a94382addb8ff4aacdba7ea2e027ad7831598b9c2ee728c26) |
| 18 | Victor Valdes | [`W18VV`](https://sepolia.etherscan.io/token/0xE430dbC10a9474AC27908c3283b750B1215C51bc) | [`0x9a74892f…3c5a`](https://app.uniswap.org/explore/pools/ethereum_sepolia/0x9a74892f706c91e062160762c79e1968d9fe477ec57a20fbb66df9cad4e43c5a) |
| 21 | Eric Abidal | [`W21EA`](https://sepolia.etherscan.io/token/0xC4cCCD829DaB6BAC12c2136479607c9519Ff9E98) | [`0xa6fe28a9…b738`](https://app.uniswap.org/explore/pools/ethereum_sepolia/0xa6fe28a913a7abe0878e74568a38052e1f08e724ebf3a9fb3b847722035fb738) |
| 26 | Lionel Messi | [`W26LM`](https://sepolia.etherscan.io/token/0x6feb4b89Bc7977146B41FDA9a2444f377790cACB) | [`0x9849f7fe…6454`](https://app.uniswap.org/explore/pools/ethereum_sepolia/0x9849f7fe7f0905f6cac9de20e0dc218e83fb545419ad9933f550ba3da8226454) |

## Demo 2 (`2026092702`) — hook [`0xbd91503c4dd270007eb697ddeab30fc87dea4088`](https://sepolia.etherscan.io/address/0xbd91503c4dd270007eb697ddeab30fc87dea4088)

| # | Player | Card | Pool |
|---|---|---|---|
| 0 | Petr Cech | [`W0PC`](https://sepolia.etherscan.io/token/0xF04a4de5DEcE722ced94E912Abd516018eE60588) | [`0xf2f3f880…0355`](https://app.uniswap.org/explore/pools/ethereum_sepolia/0xf2f3f880f79e1590eac5f91b6f00e58eaab7deb5933c3df536b4d4fcaeda0355) |
| 2 | John Terry | [`W2JT`](https://sepolia.etherscan.io/token/0xb7d23C09DCf34b5984436BeddB7FFa1eb89c38Ee) | [`0xedf640b6…92bb`](https://app.uniswap.org/explore/pools/ethereum_sepolia/0xedf640b6a8b961560920d44a96af0e2a618338a365ecd46a72cc1614f7c392bb) |
| 4 | Ashley Cole | [`W4AC`](https://sepolia.etherscan.io/token/0x722813aec83a3ff0Af1aA23eE75fffBf15De538D) | [`0x67c08562…0df2`](https://app.uniswap.org/explore/pools/ethereum_sepolia/0x67c08562bd0da10ff0717b181c5b35be5ab53527e35f2c50fd1f93d7305f0df2) |
| 5 | Michael Essien | [`W5ME`](https://sepolia.etherscan.io/token/0xea13793d1DbDA0B625c1E5aEF3310d3325A22d3d) | [`0xef32554f…5f20`](https://app.uniswap.org/explore/pools/ethereum_sepolia/0xef32554fb8a7f4a6fd9994626b0050958e58c92138e670e715a59f296ba45f20) |
| 9 | Florent Malouda | [`W9FM`](https://sepolia.etherscan.io/token/0xBA37176fE699b42AEb03C1163e1b3c033c7dD4A3) | [`0x448ee27e…5c8a`](https://app.uniswap.org/explore/pools/ethereum_sepolia/0x448ee27e37badf52823bed74182afb95f076b62a1216d49c3e7e442d18cb5c8a) |
| 10 | Didier Drogba | [`W10DD`](https://sepolia.etherscan.io/token/0xd72010728f61efeA4f27269769ea6d470c828630) | [`0x2c24e2c5…3984`](https://app.uniswap.org/explore/pools/ethereum_sepolia/0x2c24e2c5d8868df2697ba2b800311d3dd64bf817eebc8d1b08aa3f68238f3984) |
| 18 | Victor Valdes | [`W18VV`](https://sepolia.etherscan.io/token/0x19A463A04aE71a3270A45AB9329840581A4eB93D) | [`0x785c36ee…d0bc`](https://app.uniswap.org/explore/pools/ethereum_sepolia/0x785c36eee7540df5f14464781e47a769d010ffa881fd1c85519b1c4e70fad0bc) |
| 19 | Carles Puyol | [`W19CP`](https://sepolia.etherscan.io/token/0xA2734d0663A680D358e6AAE7eF027d5DE4c9042A) | [`0xd234df6c…73f5`](https://app.uniswap.org/explore/pools/ethereum_sepolia/0xd234df6c44ff534237621d3e0590007ed6df554fd103c6a934e9f97e3dc273f5) |
| 21 | Eric Abidal | [`W21EA`](https://sepolia.etherscan.io/token/0xfA2c2155210Ff4b5DD15f271c87a0f0D61c2d02f) | [`0x9c5299f8…8df3`](https://app.uniswap.org/explore/pools/ethereum_sepolia/0x9c5299f8a18b6b5742101b6cfb27fb66d5212c377e1d32943a2519513d4a8df3) |
| 25 | Andres Iniesta | [`W25AI`](https://sepolia.etherscan.io/token/0xC97DE5A8B36764F7C62E850BF7c2562CDCeDedbf) | [`0x27c17568…7b2b`](https://app.uniswap.org/explore/pools/ethereum_sepolia/0x27c175684b8bd2c567d64083514a1b40c03b6b0618c7c60fa10cfd7be5827b2b) |
| 26 | Lionel Messi | [`W26LM`](https://sepolia.etherscan.io/token/0x63E842F72Bd0D9436762EF43aA5c0CBDd5E91F12) | [`0xf226ec56…8b63`](https://app.uniswap.org/explore/pools/ethereum_sepolia/0xf226ec56585222db707cc58bb9df5961f50579283035ac7e52339cfa41828b63) |

## Demo 3 (`2026092703`) — hook [`0x071cFE36286Bec972871dc38d2FFdeC7b04c8088`](https://sepolia.etherscan.io/address/0x071cFE36286Bec972871dc38d2FFdeC7b04c8088)

| # | Player | Card | Pool |
|---|---|---|---|
| 0 | Petr Cech | [`W0PC`](https://sepolia.etherscan.io/token/0xD0aADE06caaF73f409Ee378A81ad60F89755144e) | [`0x4a486d8e…12fc`](https://app.uniswap.org/explore/pools/ethereum_sepolia/0x4a486d8e47935810389103e973cdf5d94bf14c578d0a8dce6892ad709bf012fc) |
| 2 | John Terry | [`W2JT`](https://sepolia.etherscan.io/token/0x3Dc3E5E70bbef0ED8Ad5De05dFF6Fb670f9320cd) | [`0xfced2db6…7b06`](https://app.uniswap.org/explore/pools/ethereum_sepolia/0xfced2db6550cd5c221473475b768ad67a9e28fde432b31846afc1f0c859f7b06) |
| 4 | Ashley Cole | [`W4AC`](https://sepolia.etherscan.io/token/0x46baCf3ac0cB4189cd643C0CA804dc1a38dEa469) | [`0x03d926a8…880f`](https://app.uniswap.org/explore/pools/ethereum_sepolia/0x03d926a8fa0acfc46fa2e23d2b6390753efdcb8abd90664a81df3889bda2880f) |
| 5 | Michael Essien | [`W5ME`](https://sepolia.etherscan.io/token/0x3eff4fbBD497Ffa0fB99ECEfB261d9Afa9aE07DA) | [`0x75bd6ba9…39db`](https://app.uniswap.org/explore/pools/ethereum_sepolia/0x75bd6ba9b934ebd0a0105fb124e243605ada5f5cd9d4825ac24ae8945cd639db) |
| 9 | Florent Malouda | [`W9FM`](https://sepolia.etherscan.io/token/0xe5bbCB75218F0A0BA07c1Fd91FF1DDA51eD12B3E) | [`0x5af66ea3…9e20`](https://app.uniswap.org/explore/pools/ethereum_sepolia/0x5af66ea30d5b67d902140e0a8dc20c4f580a00aa50a44426653f7edc0c829e20) |
| 10 | Didier Drogba | [`W10DD`](https://sepolia.etherscan.io/token/0x2192E29a47371085cC2ED82BDC66d284339112F2) | [`0xa0fa0991…7860`](https://app.uniswap.org/explore/pools/ethereum_sepolia/0xa0fa09919b5d19a386a761ae8a8bb2fa42ddf193353c6f3f3f190be0f1e67860) |
| 18 | Victor Valdes | [`W18VV`](https://sepolia.etherscan.io/token/0xfb8c391c9d7a82A38860b7Be307E4E4fc8848AC5) | [`0xe9da20ab…8323`](https://app.uniswap.org/explore/pools/ethereum_sepolia/0xe9da20ab8b7db73de280ea328e15379e0894dc19f0232eeae9e842b3a6ef8323) |
| 19 | Carles Puyol | [`W19CP`](https://sepolia.etherscan.io/token/0xd1806C990486FA9284f763320521c85382d3549b) | [`0x439518f6…2067`](https://app.uniswap.org/explore/pools/ethereum_sepolia/0x439518f6509dcebe5fe66345667fffcdfd2cae3b6eb3025a43436f40a7572067) |
| 21 | Eric Abidal | [`W21EA`](https://sepolia.etherscan.io/token/0x0840b091611821ccB0F7133EA076f12bEc7B084A) | [`0xbe165805…c913`](https://app.uniswap.org/explore/pools/ethereum_sepolia/0xbe165805412a0040c16eeb085ffd30aa228cce3a2daaaa7f1c4604a31056c913) |
| 25 | Andres Iniesta | [`W25AI`](https://sepolia.etherscan.io/token/0xbf8432ceEA4F8b7B9b48b26D599158338fB20091) | [`0x13baa174…3b80`](https://app.uniswap.org/explore/pools/ethereum_sepolia/0x13baa174506a181dd15d1e0f2f0ba7b5fdca64480626ec07c24905c210343b80) |
| 26 | Lionel Messi | [`W26LM`](https://sepolia.etherscan.io/token/0x545755653D918fD3c8d27e539Cd297f2dA22b854) | [`0x6a4e82da…afb5`](https://app.uniswap.org/explore/pools/ethereum_sepolia/0x6a4e82daec02433531564e76b85fd132fe12f975037553b3bab0088d02c6afb5) |

## Demo 4 (`2026092704`) — hook [`0x1d3b9458e97827fa32225de2534a4f8669374088`](https://sepolia.etherscan.io/address/0x1d3b9458e97827fa32225de2534a4f8669374088)

| # | Player | Card | Pool |
|---|---|---|---|
| 0 | Petr Cech | [`W0PC`](https://sepolia.etherscan.io/token/0x10a8663c623425D25dB13d7f4843c46cBa37d1A7) | [`0xa4b5d5b6…5760`](https://app.uniswap.org/explore/pools/ethereum_sepolia/0xa4b5d5b6d8b348c7445ea2917a2bca0ac0d7fba5ec1df0b94523c78c03295760) |
| 2 | John Terry | [`W2JT`](https://sepolia.etherscan.io/token/0xF15DeA86E201c2D6a48E71C419F8A1Ef4F72e528) | [`0x7a14e9db…ecd8`](https://app.uniswap.org/explore/pools/ethereum_sepolia/0x7a14e9dbe41b57fc2f502fdd3e4899806a141cea0fb279d9e1f3e6d6d240ecd8) |
| 4 | Ashley Cole | [`W4AC`](https://sepolia.etherscan.io/token/0x91b7502F164BBa218aC64c34E9bDfDb4567625aB) | [`0x3b65e672…50ce`](https://app.uniswap.org/explore/pools/ethereum_sepolia/0x3b65e6727e775f274d23f1337fffc64f7a548847ad80c69ddd4b3289cced50ce) |
| 5 | Michael Essien | [`W5ME`](https://sepolia.etherscan.io/token/0xCef6e2E04235f9BeF7F6c672c6f7F037e6dDf644) | [`0x88fe119d…4035`](https://app.uniswap.org/explore/pools/ethereum_sepolia/0x88fe119d336bb8d33da6e017c276e233bed77638d8955ea3938bcdfd0cc24035) |
| 9 | Florent Malouda | [`W9FM`](https://sepolia.etherscan.io/token/0xeFC2b23F3514231509aa778F5F6CEf5f973E5e17) | [`0x70cd7d04…e723`](https://app.uniswap.org/explore/pools/ethereum_sepolia/0x70cd7d04792cc1b2e139cd775e8d35669d57fea0b8b96e1e01e1309f739ee723) |
| 10 | Didier Drogba | [`W10DD`](https://sepolia.etherscan.io/token/0x8b0247D65F4C2517cDb60E80CD6E9cF2353Ee271) | [`0x6ff69c57…dd00`](https://app.uniswap.org/explore/pools/ethereum_sepolia/0x6ff69c57781c02e1d3b13cddab142ce6c58d48c69ab60b8bc45ed40bfa7ddd00) |
| 18 | Victor Valdes | [`W18VV`](https://sepolia.etherscan.io/token/0x710Bd444DcF431BA50729Dd1EE4290ff66E37DAD) | [`0xb9b752a8…663e`](https://app.uniswap.org/explore/pools/ethereum_sepolia/0xb9b752a812fee6252cca70a389c561ba67930e447c72f834ccd4f20dc970663e) |
| 19 | Carles Puyol | [`W19CP`](https://sepolia.etherscan.io/token/0x7F313Eca025513fa26B559D92D8E58B326a72f20) | [`0x1fe21bd7…e9f5`](https://app.uniswap.org/explore/pools/ethereum_sepolia/0x1fe21bd7eb2d858bd36361beb8367c4e33315fdfefd9ddd7fe612923e440e9f5) |
| 21 | Eric Abidal | [`W21EA`](https://sepolia.etherscan.io/token/0xc0D912a5aEa5434C453FdEFEcfcC1B2F6209829E) | [`0xad9eeef3…b240`](https://app.uniswap.org/explore/pools/ethereum_sepolia/0xad9eeef32ee1aa53d9a6b233d3a9d172dc0204b90dc866ed6f0d81ddcbceb240) |
| 25 | Andres Iniesta | [`W25AI`](https://sepolia.etherscan.io/token/0x7cA1E36C2e4fD0c149638D0150767F3001A5464d) | [`0xf28d25e7…433c`](https://app.uniswap.org/explore/pools/ethereum_sepolia/0xf28d25e799cdb42bffe7c7e450b7c22956c4574097b1444c1eac5347f389433c) |
| 26 | Lionel Messi | [`W26LM`](https://sepolia.etherscan.io/token/0x11f0eF42e8F6D58A9Ddf239C6044cbE8BaB34Abc) | [`0x893f19a7…ac32`](https://app.uniswap.org/explore/pools/ethereum_sepolia/0x893f19a7a6d41394cd7457d3da39a806b8e570175694768376608c5794b3ac32) |
