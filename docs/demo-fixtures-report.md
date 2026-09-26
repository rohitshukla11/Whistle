# Demo fixtures — deployment report

Generated 2026-09-26T04:50:14.081Z from chain state.

| fixture | id | wall time | pools | agents (mandates, cap) | bound now | state | protected |
|---|---|---|---|---|---|---|---|
| Settled showcase | `20260926` | — | 11/11 | 3/3 · 2,000,000 USDC | no — Activate | SETTLED | no |
| Demo 1 | `2026092701` | — | 6/11 | 3/3 · 500, 200 USDC | yes | SETTLED | yes |
| Demo 2 | `2026092702` | 0m venue · 10m seed (pipelined) · 0.0109 ETH seed | 11/11 | 3/3 · 500 USDC | no — Activate | PRE_MATCH | no |
| Demo 3 | `2026092703` | 0m venue · 10m seed (pipelined) · 0.0150 ETH seed | 11/11 | 3/3 · 500 USDC | no — Activate | PRE_MATCH | yes |
| Demo 4 | `2026092704` | — | not deployed | | | | |
| Demo 5 | `2026092705` | — | not deployed | | | | |
| Demo 6 | `2026092706` | — | not deployed | | | | |
| Demo 7 | `2026092707` | — | not deployed | | | | |

`AgentRegistry.market()` = `0x4b7373E4512C45Dff92b1c4a6048Cd3240218088`. One fixture is bound at a time; every presentation starts with Activate.

## ETH on every account

| account | address | ETH |
|---|---|---|
| owner 0x6834 | `0x68343Aa0598b7FCAA102769D172e59cdDfae10f2` | 1.68357 |
| service | `0x7e05F1dc6378Ed8B65f46684a1115B6fC3231927` | 0.13003 |
| A agent 1 | `0xB14c5eB52Ccc6c27810277D6db3E795B4459B8BA` | 0.00939 |
| A agent 2 | `0xA72a884438BB4C2588f0535c4a323dF93A45d2cd` | 0.00882 |
| A agent 3 | `0x13e2A509237837b7e6475e9F7F75C88a776CEE7E` | 0.00939 |
| A agent 4 (managed) | `0x069Db7BBCa587381aaa611fdc5dD962bD38E8e3d` | 0.00330 |
| Demo 1 agent 1 | `0x7A73231811dAB9300C5bF9b494Fc1d04C7DBC9bE` | 0.00799 |
| Demo 1 agent 2 | `0x65Ea9fe72a29C836df8080F6DE0157b2F06869c7` | 0.00896 |
| Demo 1 agent 3 | `0xf7929C1003b837B4302178C82076560EB36B8A16` | 0.00879 |
| Demo 1 agent 4 (managed) | `0xCcE845Fc6037CA6d047F8b8f074872C81c90Db43` | 0.00295 |
| Demo 2 agent 1 | `0xd49bba5A40BBE826C417F65EFbb46Cb7E3317b7C` | 0.00938 |
| Demo 2 agent 2 | `0xb3B1f2726FB7c5d8653260196372Ab64535B167C` | 0.00937 |
| Demo 2 agent 3 | `0x9176C30320e92E5F61bDcAd2ee5Eb23767f210f1` | 0.00939 |
| Demo 3 agent 1 | `0x390a17c81d4c2781581b7324d3A25615f3f61B4d` | 0.00938 |
| Demo 3 agent 2 | `0x3B744c72c1da4BeF6f1E6001aC70447ddc3d66cf` | 0.00937 |
| Demo 3 agent 3 | `0xDcd121F1c89FB2363cEB9d494eB53FeF5Bb02542` | 0.00938 |
| Demo 4 agent 1 | `0x6800CF85106BfCc5Ad940618CA30eBd89C46c9D0` | 0.01000 |
| Demo 4 agent 2 | `0xa19e79a6FB9CA0b4eDBcd6E111fdE4d1413BEa52` | 0.01000 |
| Demo 4 agent 3 | `0xA2BEb0b51EAc5B10530373Fe9EE62E8FDF0CEe02` | 0.01000 |
| Demo 5 agent 1 | `0x5fB22Fa9cA15f2330B2475C3dD360cc3438e356c` | 0.01000 |
| Demo 5 agent 2 | `0x89b4d2C37167B910cDd5669aB681fbAa62ea53f4` | 0.01000 |
| Demo 5 agent 3 | `0xC15A4e73D68289c9FF78c3A36589aa3003A2de34` | 0.01000 |
| Demo 6 agent 1 | `0xFE026eBB3c7E5769EeC1162EDFCb85FB1D04c558` | 0.01000 |
| Demo 6 agent 2 | `0x8d10338174DbC34D967EA9C022e1C19d62163eBA` | 0.01000 |
| Demo 6 agent 3 | `0xAbe4363886b4cfe7b76555f6602f1fe5389b37Dc` | 0.01000 |
| Demo 7 agent 1 | `0x0Cb38B2aDED8664abBaBbab0B673867Df11F3Ba7` | 0.01000 |
| Demo 7 agent 2 | `0x98773A534f0F40dD0e48eDF58D7b01f7EbF045c1` | 0.01000 |
| Demo 7 agent 3 | `0x06b67dE47ad647B2c12e40c1fdfD98C6898D4818` | 0.01000 |
| legacy C-1 | `0xa1B0BeAFc58260d382d92eF3EEDefd641BfAE800` | 0.01000 |
| legacy C-2 | `0x9937CEF9FFfBCe78b77CD8d348567c9360cA3AB0` | 0.01000 |
| legacy C-3 | `0xF62E80D648d438FeB312e55DD94AabF050E6Beab` | 0.01000 |
| **total** | | **2.07947** |

Managed pool keys (agents 4–6 per fixture) hold nothing until `/api/agents/assign` funds one; unassigned ones are not listed.
