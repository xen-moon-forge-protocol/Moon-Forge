/**
 * Moon Wars — local practice engine (free, off-chain, no XNT involved).
 *
 * Rules: 20 HP each, mana ramps each turn, a unit cannot attack on the turn it is summoned,
 * each unit attacks at most once per turn, units on the enemy field must be destroyed before
 * attacking the player directly. The training bot plays greedily every turn.
 */

export enum ElementType {
    LUNAR = 0,
    COSMIC = 1,
    SOLAR = 2,
    VOID = 3,
}

export const ELEMENT_NAMES = ['Lunar Dust', 'Cosmic Shard', 'Solar Core', 'Void Anomaly'];

export interface Card {
    uid: number;
    element: ElementType;
    power: number;
    defense: number;
    cost: number;
    name: string;
    /** false on the turn it was summoned and after it attacked */
    canAttack: boolean;
}

export interface PlayerState {
    address: string;
    health: number;
    mana: number;
    hand: Card[];
    field: Card[];
    deck: Card[];
    graveyard: Card[];
}

export interface GameState {
    gameId: string;
    round: number;
    turnPlayer: string;
    player1: PlayerState;
    player2: PlayerState;
    status: 'WAITING' | 'PLAYING' | 'FINISHED';
    winner: string | null;
    actionLog: string[];
}

export const CARD_STATS: Record<ElementType, { power: number; defense: number; cost: number }> = {
    [ElementType.LUNAR]: { power: 2, defense: 2, cost: 1 },
    [ElementType.COSMIC]: { power: 4, defense: 3, cost: 2 },
    [ElementType.SOLAR]: { power: 6, defense: 4, cost: 3 },
    [ElementType.VOID]: { power: 10, defense: 10, cost: 5 },
};

/** 10-card practice deck: 4 Lunar, 3 Cosmic, 2 Solar, 1 Void (same for both sides). */
export const PRACTICE_DECK: ElementType[] = [0, 0, 0, 0, 1, 1, 1, 2, 2, 3];

let nextUid = 1;

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
            actionLog: ['Game initialized. Waiting for decks...'],
        };
    }

    private initPlayer(addr: string): PlayerState {
        return { address: addr, health: 20, mana: 1, hand: [], field: [], deck: [], graveyard: [] };
    }

    public setDeck(playerAddr: string, elements: ElementType[]) {
        const player = this.getPlayer(playerAddr);
        player.deck = elements.map((e) => this.makeCard(e));
        this.shuffleDeck(player);
        this.drawCards(player, 3);
        if (this.state.player1.deck.length > 0 && this.state.player2.deck.length > 0) {
            this.state.status = 'PLAYING';
            this.log('Both decks ready. Game start!');
        }
    }

    private makeCard(element: ElementType): Card {
        const s = CARD_STATS[element];
        return { uid: nextUid++, element, power: s.power, defense: s.defense, cost: s.cost, name: ELEMENT_NAMES[element], canAttack: false };
    }

    private requireTurn(playerAddr: string) {
        if (this.state.status !== 'PLAYING') throw new Error('Game not active');
        if (this.state.turnPlayer !== playerAddr) throw new Error('Not your turn');
    }

    public playCard(playerAddr: string, cardIndex: number) {
        this.requireTurn(playerAddr);
        const player = this.getPlayer(playerAddr);
        const card = player.hand[cardIndex];
        if (!card) throw new Error('Invalid card');
        if (player.mana < card.cost) throw new Error('Not enough mana');
        if (player.field.length >= 6) throw new Error('Field is full (max 6 units)');
        player.mana -= card.cost;
        player.hand.splice(cardIndex, 1);
        card.canAttack = false; // summoning sickness
        player.field.push(card);
        this.log(`${this.short(playerAddr)} summoned ${card.name} (${card.power}/${card.defense})`);
        this.resolveEffects(card, this.getOpponent(playerAddr));
        this.checkWinCondition();
    }

    public attack(playerAddr: string, cardIndex: number, targetIndex: number | 'face') {
        this.requireTurn(playerAddr);
        const attacker = this.getPlayer(playerAddr);
        const defender = this.getOpponent(playerAddr);
        const card = attacker.field[cardIndex];
        if (!card) throw new Error('Invalid attacker');
        if (!card.canAttack) throw new Error(`${card.name} cannot attack this turn`);

        if (targetIndex === 'face') {
            if (defender.field.length > 0) throw new Error('Destroy the enemy units first');
            defender.health -= card.power;
            this.log(`${card.name} hits ${this.short(defender.address)} for ${card.power}`);
        } else {
            const target = defender.field[targetIndex];
            if (!target) throw new Error('Invalid target');
            target.defense -= card.power;
            card.defense -= target.power;
            this.log(`${card.name} attacks ${target.name}`);
            if (target.defense <= 0) {
                defender.field.splice(targetIndex, 1);
                defender.graveyard.push(target);
                this.log(`${target.name} destroyed`);
            }
            if (card.defense <= 0) {
                attacker.field.splice(attacker.field.indexOf(card), 1);
                attacker.graveyard.push(card);
                this.log(`${card.name} destroyed`);
            }
        }
        card.canAttack = false;
        this.checkWinCondition();
    }

    public endTurn(playerAddr?: string) {
        if (this.state.status !== 'PLAYING') return;
        if (playerAddr && playerAddr !== this.state.turnPlayer) throw new Error('Not your turn');
        const next = this.getOpponent(this.state.turnPlayer);
        this.state.turnPlayer = next.address;
        this.state.round++;
        next.mana = Math.min(10, Math.ceil(this.state.round / 2) + 1);
        next.field.forEach((c) => { c.canAttack = true; });
        this.drawCards(next, 1);
        this.log(`${this.short(next.address)}'s turn`);
        this.checkWinCondition();
    }

    /** Greedy training bot: plays the most expensive affordable cards, then attacks with every ready unit. */
    public botTurn(botAddr: string) {
        if (this.state.status !== 'PLAYING' || this.state.turnPlayer !== botAddr) return;
        const bot = this.getPlayer(botAddr);
        const enemy = this.getOpponent(botAddr);

        // play cards
        for (;;) {
            if (this.state.status !== 'PLAYING') return;
            let best = -1;
            bot.hand.forEach((c, i) => {
                if (c.cost <= bot.mana && (best < 0 || c.cost > bot.hand[best].cost)) best = i;
            });
            if (best < 0) break;
            this.playCard(botAddr, best);
        }

        // attack: kill what it can, otherwise hit the weakest unit, face when the field is clear
        for (const unit of [...bot.field]) {
            if (this.state.status !== 'PLAYING') return;
            const idx = bot.field.indexOf(unit);
            if (idx < 0 || !unit.canAttack) continue;
            if (enemy.field.length === 0) {
                this.attack(botAddr, idx, 'face');
                continue;
            }
            let target = enemy.field.findIndex((t) => t.defense <= unit.power && t.power < unit.defense);
            if (target < 0) target = enemy.field.findIndex((t) => t.defense <= unit.power);
            if (target < 0) {
                target = 0;
                enemy.field.forEach((t, i) => { if (t.defense < enemy.field[target].defense) target = i; });
            }
            this.attack(botAddr, idx, target);
        }
        this.endTurn(botAddr);
    }

    private getPlayer(addr: string) {
        return this.state.player1.address === addr ? this.state.player1 : this.state.player2;
    }

    private getOpponent(addr: string) {
        return this.state.player1.address === addr ? this.state.player2 : this.state.player1;
    }

    private drawCards(player: PlayerState, count: number) {
        for (let i = 0; i < count; i++) {
            const card = player.deck.pop();
            if (card) player.hand.push(card);
            else {
                player.health -= 1;
                this.log(`${this.short(player.address)} has no cards left: 1 fatigue damage`);
            }
        }
    }

    /** Fisher–Yates shuffle (practice only; not a verifiable RNG). */
    private shuffleDeck(player: PlayerState) {
        const d = player.deck;
        for (let i = d.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [d[i], d[j]] = [d[j], d[i]];
        }
    }

    private resolveEffects(card: Card, enemy: PlayerState) {
        if (card.element === ElementType.SOLAR) {
            enemy.health -= 2;
            this.log(`${card.name} burns ${this.short(enemy.address)} for 2`);
        }
    }

    private short(addr: string) {
        return addr.length > 12 ? addr.slice(0, 6) : addr;
    }

    private log(msg: string) {
        this.state.actionLog.push(`[R${this.state.round}] ${msg}`);
    }

    private checkWinCondition() {
        if (this.state.status === 'FINISHED') return;
        const p1 = this.state.player1, p2 = this.state.player2;
        if (p1.health <= 0 || p2.health <= 0) {
            this.state.status = 'FINISHED';
            this.state.winner = p1.health <= 0 && p2.health <= 0 ? null : p1.health <= 0 ? p2.address : p1.address;
            this.log(this.state.winner ? `${this.short(this.state.winner)} wins!` : 'Draw!');
        }
    }
}
