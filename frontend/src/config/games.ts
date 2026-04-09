// Contract addresses — filled after deploy. All set to address(0) placeholder.
export const GAME_CONTRACTS = {
    COIN_FLIP:   '0x0000000000000000000000000000000000000000', // MoonGames.sol
    HIGH_LOW:    '0x0000000000000000000000000000000000000000', // MoonGames.sol (same contract)
    LOTTERY:     '0x0000000000000000000000000000000000000000', // MoonLottery.sol
    JACKPOT:     '0x0000000000000000000000000000000000000000', // MoonJackpot.sol
    DUEL:        '0x0000000000000000000000000000000000000000', // ArtifactDuel.sol
    PREDICTIONS: '0x0000000000000000000000000000000000000000', // MoonPredictions.sol
    VOID_RUSH:   '0x0000000000000000000000000000000000000000', // VoidRush.sol
};

export const GAME_FEES = {
    COIN_FLIP: 0.035,   // 3.5%
    HIGH_LOW: 0.04,     // 4%
    LOTTERY: 0.20,      // 20% Burn
    JACKPOT: 0.05,      // 5%
    DUEL: 0.025,        // 2.5%
    PREDICTIONS: 0.02,  // 2%
    VOID_RUSH: 0.02,    // 2% (probability skew)
};

export const GAME_CONFIG = {
    COIN_FLIP: {
        minBet: 0.1,
        maxBet: 100,
        tiers: [0.1, 1, 10, 50, 100]
    },
    HIGH_LOW: {
        minBet: 0.1,
        maxBet: 100,
        tiers: [0.1, 1, 10, 50]
    },
    JACKPOT: {
        minEntry: 1,
        tiers: [1, 5, 20, 50, 100]
    },
    LOTTERY: {
        ticketPrice: 10, // 10 XNT per ticket (matches TICKET_PRICE in MoonLottery.sol)
        burnRate: 0.20   // 20% of prize pool sent to dead address permanently
    },
    DUEL: {
        entryFee: 2,     // 2 XNT per duel (matches DUEL_BET in ArtifactDuel.sol)
        prizePool: 3.90  // 2*2 * 0.975 = 3.90 (winner gets 97.5%)
    },
    PREDICTIONS: {
        marketBond: 50,
        minBet: 5  // 5 XNT minimum (matches MIN_BET in MoonPredictions.sol)
    },
    VOID: {
        minBet: 0.1,
        maxBet: 100,
        tiers: [0.1, 1, 5, 10, 50, 100]
    }
};
