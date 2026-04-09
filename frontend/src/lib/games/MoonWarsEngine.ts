/**
 * Moon Wars Game Engine v0.1
 * 
 * Implements the core logic for the Phase 3 Card Game.
 * This TypeScript logic mirrors what will be implemented in Solidity.
 */

export enum ElementType {
    LUNAR = 0,   // Common
    COSMIC = 1,  // Rare
    SOLAR = 2,   // Epic
    VOID = 3     // Legendary
}

export interface Card {
    tokenId: number;
    element: ElementType;
    power: number;
    defense: number;
    name: string;
    variant: string; // e.g., "frost_blue" determines sub-ability
}

export interface PlayerState {
    address: string;
    health: number; // Starts at 20
    mana: number;   // Starts at 1, +1 per turn
    hand: Card[];
    field: Card[];
    deck: Card[];
    graveyard: Card[];
    isFrozen: boolean; // Skip turn flag
}

export interface GameState {
    gameId: string;
    round: number;
    turnPlayer: string; // Address
    player1: PlayerState;
    player2: PlayerState;
    status: 'WAITING' | 'PLAYING' | 'FINISHED';
    winner: string | null;
    actionLog: string[];
}

// ═══════════════════════════════════════════════════════════════════════════
//                              CARD DATABASE
// ═══════════════════════════════════════════════════════════════════════════

export const CARD_STATS: Record<ElementType, { power: number; defense: number; cost: number }> = {
    [ElementType.LUNAR]: { power: 2, defense: 2, cost: 1 },
    [ElementType.COSMIC]: { power: 4, defense: 3, cost: 2 },
    [ElementType.SOLAR]: { power: 6, defense: 4, cost: 3 },
    [ElementType.VOID]: { power: 10, defense: 10, cost: 5 },
};

// ═══════════════════════════════════════════════════════════════════════════
//                              ENGINE LOGIC
// ═══════════════════════════════════════════════════════════════════════════

export class MoonWarsEngine {
    state: GameState;

    constructor(gameId: string, p1Address: string, p2Address: string) {
        this.state = {
            gameId,
            round: 1,
            turnPlayer: p1Address,
            player1: this.initPlayer(p1Address),
            player2: this.initPlayer(p2Address),
            status: 'WAITING',
            winner: null,
            actionLog: ['Game initialized. Waiting for decks...']
        };
    }

    private initPlayer(addr: string): PlayerState {
        return {
            address: addr,
            health: 20,
            mana: 1,
            hand: [],
            field: [],
            deck: [],
            graveyard: [],
            isFrozen: false
        };
    }

    // Load NFTs as Deck
    public setDeck(playerAddr: string, tokenIds: number[]) {
        const player = this.getPlayer(playerAddr);
        player.deck = tokenIds.map(id => this.mintCardFromToken(id));
        this.shuffleDeck(player);
        this.drawCards(player, 3); // Initial hand

        if (this.state.player1.deck.length > 0 && this.state.player2.deck.length > 0) {
            this.state.status = 'PLAYING';
            this.log('Both decks ready. Game Start!');
        }
    }

    // Convert NFT ID to Game Card
    private mintCardFromToken(id: number): Card {
        let element = ElementType.LUNAR;
        if (id > 600) element = ElementType.COSMIC;
        if (id > 900) element = ElementType.SOLAR;
        if (id > 990) element = ElementType.VOID;

        const stats = CARD_STATS[element];
        return {
            tokenId: id,
            element,
            power: stats.power,
            defense: stats.defense,
            name: `Artifact #${id}`,
            variant: 'standard' // TODO: map variant from ID
        };
    }

    // Core Action: Play Card
    public playCard(playerAddr: string, cardIndex: number) {
        if (this.state.status !== 'PLAYING') throw new Error("Game not active");
        if (this.state.turnPlayer !== playerAddr) throw new Error("Not your turn");

        const player = this.getPlayer(playerAddr);
        const card = player.hand[cardIndex];
        const cost = CARD_STATS[card.element].cost;

        if (player.mana < cost) throw new Error("Not enough mana");

        // Move to field
        player.mana -= cost;
        player.hand.splice(cardIndex, 1);
        player.field.push(card);
        this.log(`${playerAddr.slice(0, 6)} summoned ${card.name} (${card.power}/${card.defense})`);

        // Trigger Entry Effect based on variant/element
        this.resolveEffects(card, player, this.getOpponent(playerAddr));
    }

    // Core Action: Attack
    public attack(playerAddr: string, cardIndex: number, targetIndex: number | 'face') {
        if (this.state.turnPlayer !== playerAddr) throw new Error("Not your turn");

        const attacker = this.getPlayer(playerAddr);
        const defender = this.getOpponent(playerAddr);
        const card = attacker.field[cardIndex];

        if (!card) throw new Error("Invalid attacker");

        if (targetIndex === 'face') {
            if (defender.field.length > 0) throw new Error("Must destroy units first (Taunt rule)");
            defender.health -= card.power;
            this.log(`${card.name} attacked Direct Life! -${card.power} HP`);
        } else {
            const target = defender.field[targetIndex];
            if (!target) throw new Error("Invalid target");

            // Combat
            target.defense -= card.power;
            card.defense -= target.power;
            this.log(`${card.name} attacked ${target.name}. Both took damage.`);

            if (target.defense <= 0) {
                defender.field.splice(targetIndex, 1);
                defender.graveyard.push(target);
                this.log(`${target.name} destroyed!`);
            }
            if (card.defense <= 0) {
                attacker.field.splice(cardIndex, 1);
                attacker.graveyard.push(card);
                this.log(`${card.name} destroyed!`);
            }
        }

        this.checkWinCondition();
    }

    public endTurn() {
        const nextPlayer = this.getOpponent(this.state.turnPlayer);
        this.state.turnPlayer = nextPlayer.address;
        this.state.round++;

        // Turn Start Logic
        nextPlayer.mana = Math.min(10, Math.ceil(this.state.round / 2) + 1); // Ramp mana
        this.drawCards(nextPlayer, 1);
        this.log(`Turn End. ${nextPlayer.address.slice(0, 6)}'s turn.`);
    }

    // Helpers
    private getPlayer(addr: string) {
        return this.state.player1.address === addr ? this.state.player1 : this.state.player2;
    }

    private getOpponent(addr: string) {
        return this.state.player1.address === addr ? this.state.player2 : this.state.player1;
    }

    private drawCards(player: PlayerState, count: number) {
        for (let i = 0; i < count; i++) {
            if (player.deck.length === 0) {
                player.health -= 1; // Fatigue damage
                this.log("Deck empty! Taking fatigue damage.");
                continue;
            }
            const card = player.deck.pop();
            if (card) player.hand.push(card);
        }
    }

    private shuffleDeck(player: PlayerState) {
        player.deck.sort(() => Math.random() - 0.5);
    }

    private resolveEffects(card: Card, user: PlayerState, enemy: PlayerState) {
        // Placeholder for elemental effects
        if (card.element === ElementType.SOLAR) {
            enemy.health -= 2; // Burn damage on entry
            this.log(`${card.name} burns opponent for 2 damage!`);
        }
        // More effects to come in Phase 3 iterations
    }

    private log(msg: string) {
        this.state.actionLog.push(`[${new Date().toLocaleTimeString()}] ${msg}`);
    }

    private checkWinCondition() {
        if (this.state.player1.health <= 0) {
            this.state.status = 'FINISHED';
            this.state.winner = this.state.player2.address;
            this.log("Player 2 Wins!");
        } else if (this.state.player2.health <= 0) {
            this.state.status = 'FINISHED';
            this.state.winner = this.state.player1.address;
            this.log("Player 1 Wins!");
        }
    }
}
