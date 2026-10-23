# CU measurements — Moon Forge program 57UE1U1t23ztg2noLp8pcpGW1B1Xw25rLH6ra9Mchea9 (rules v2 binary)

Binary: ProgramData last-deploy slot 85429880 (deployed 2026-10-12 12:59:36 UTC; read back on 2026-10-22, after this run, and unchanged). The site applies this table only while the live program has that slot (src/lib/cu.ts CU_MEASURED_DEPLOY_SLOT).

Method: `connection.simulateTransaction(tx)` on https://rpc.mainnet.x1.xyz at 2026-10-22T13:21:53.189Z, read-only (no key, no signature; sigVerify=false; real on-chain accounts stand in as signers). Limit = ceil(units × 1.25) + 300 (two ComputeBudget builtin instructions at 150 CU each: ours plus one a wallet may inject). Each number is for ONE transaction of ONE instruction, as the site sends them. The site re-measures every transaction with the same call before signing and uses this table ONLY when that simulation fails; rows marked SKIP get no static limit (default runtime budget).

| instruction | units (simulated) | static limit | note |
|---|---:|---:|---|
| donate | 16743 | 21229 |  |
| system_transfer | 150 | 488 | fund / sweep of the Moon Wars move key |
| open_player | 13928 | 17710 |  |
| deposit | 8566 | 11008 |  |
| withdraw | 6140 | 7975 | chain wallet ix#2 |
| set_session | 6143 | 7979 |  |
| place_bet / enter_jackpot | SKIP | - | not measurable on mainnet now no PlayerState holds >= 0.01 XNT |
| enter_draw | 48467 | 60884 | 1 chip, 0 tickets; chain chips+draw ix#3 |
| forge_artifact | SKIP | - | not measurable on mainnet now no read-only wallet holds >= 11 XNT |
| recycle_artifact / claim_artifact_chips / create_duel | SKIP | - | not measurable on mainnet now no live Artifact on mainnet |
| claim_airdrop | 80648 | 101110 | proof depth 9 |
| claim_instant | SKIP | - | not measurable on mainnet now no unclaimed tier-0 leaf in an open epoch |
| claim_mission | SKIP | - | not measurable on mainnet now no unclaimed tier-1/2 leaf in an open epoch |
| withdraw_vested / eject | SKIP | - | not measurable on mainnet now no open Mission account on mainnet |
| house_deposit | 30004 | 37805 | 1 XNT; chain house1 ix#0 |
| house_request_withdraw | 5650 | 7363 | 1 XNT; chain house1 ix#1 |
| house_withdraw | SKIP | - | not measurable on mainnet now no HouseShare with unlocked pending shares |
| draw_jackpot | SKIP | - | not measurable on mainnet now no ended, undrawn jackpot round |
| settle_jackpot | SKIP | - | not measurable on mainnet now no jackpot round in the drawing state |
| close_jackpot_entry | SKIP | - | not measurable on mainnet now no refunded jackpot round with entries |
| draw_draw | SKIP | - | not measurable on mainnet now no ended, undrawn lottery round |
| settle_draw | SKIP | - | not measurable on mainnet now no lottery round in the drawing state |
| settle_bet | SKIP | - | not measurable on mainnet now no open Bet account on mainnet |
| cancel_duel / join_duel | SKIP | - | not measurable on mainnet now no open duel |
| claim_duel_timeout | SKIP | - | not measurable on mainnet now no joined duel past its deadline |
| reveal_duel | 32495 | 40919 | two fake signers; chain duel-join-reveal ix#8 |
| cancel_war | SKIP | - | not measurable on mainnet now no open war |
| start_war | SKIP | - | not measurable on mainnet now no war in the starting state |
| war_summon / war_attack / war_end_turn / claim_war_timeout | SKIP | - | not measurable on mainnet now no active war |
| settle_war | SKIP | - | not measurable on mainnet now no finished, unsettled war |
| create_war / join_war | SKIP | - | not measurable on mainnet now real Moon Wars creation is PAUSED on the site (owner decision) |
| enter_prediction | SKIP | - | not measurable on mainnet now Predictions are off the site (owner decision) |
| claim_prediction | SKIP | - | not measurable on mainnet now no PredEntry account on mainnet |
| lock_prediction | SKIP | - | not measurable on mainnet now no open round past its lock time |
| settle_prediction | SKIP | - | not measurable on mainnet now no locked round past its end time |
| claim_drop / claim_drop_xnt | SKIP | - | not measurable on mainnet now needs a drawn, won, unclaimed Forge Drop leaf (none found by the simple scan; v2 oracle seals drops) |
| place_bet:coinflip | 39489 | 49662 | stake 0.01 XNT; chain place_bet:coinflip ix#2 |
| place_bet:highlow | 39511 | 49689 | stake 0.01 XNT; chain place_bet:highlow ix#2 |
| place_bet:voidrush | 39510 | 49688 | stake 0.01 XNT; chain place_bet:voidrush ix#2 |
| enter_jackpot | 36548 | 45985 | opens round 0; chain jackpot ix#2 |
| forge_artifact:t0 | 83417 | 104572 | Lunar Dust serial 0; chain forge0 ix#0 |
| recycle_artifact | 32679 | 41149 | Lunar Dust serial 0; chain forge0 ix#1 |
| forge_artifact:t1 | 85543 | 107229 | serial 0, max 26.50 XNT; chain forge1 ix#0 |
| forge_artifact:t2 | 90016 | 112820 | serial 0, max 63.60 XNT; chain forge2 ix#0 |
| forge_artifact:t3 | 83820 | 105075 | serial 0, max 212.00 XNT; chain forge3 ix#0 |
| claim_artifact_chips | 21383 | 27029 | 1 chip, 0 tickets; chain chips+draw ix#2 |
| create_duel | 29359 | 36999 | stake 0.1 XNT; chain duel-cancel ix#3 |
| cancel_duel | 10455 | 13369 | stake 0.1 XNT; chain duel-cancel ix#4 |
| join_duel | 23260 | 29375 | two fake signers; chain duel-join-reveal ix#7 |

Measured: 24 / 49. Regenerate after every program upgrade: `node measure-cu.mjs` (this file).