//! ═══════════════════════════════════════════════════════════════════════════
//!                    MOON FORGE — ANCHOR PROGRAM (X1 SVM)
//! ═══════════════════════════════════════════════════════════════════════════
//!
//! DEPLOYED: 57UE1U1t23ztg2noLp8pcpGW1B1Xw25rLH6ra9Mchea9 (X1 mainnet)
//!
//! FULL FLOW:
//!
//!   1. User burns XEN on EVM (MoonForgePortal.sol) choosing tier + NFT Artifact.
//!      Portal emits: MissionStarted(pilot, xen_amount, tier, x1_address, referrer)
//!
//!   2. Oracle reads EVM event, calculates XNT via:
//!        ForgeScore = sqrt(XEN × CWF) × Tier_Multiplier × NFT_Artifact_Boost
//!      NFT Artifact boost (5/10/20/50%) is already included in the leaf `amount`.
//!      Oracle generates Merkle tree and publishes root via update_merkle_root().
//!
//!   3. User calls claim_and_start_mission() on X1 (SINGLE STEP):
//!      - Verifies Merkle proof
//!      - XNT is transferred from reward_vault DIRECTLY to the VestingAccount PDA
//!      - Each mission has its own isolated balance — no sharing
//!      - ClaimReceipt PDA prevents double-claim for the same epoch
//!
//!   4. claim_vested() withdraws XNT linearly FROM the pilot's VestingAccount PDA.
//!      Mission A never touches Mission B's XNT.
//!
//!   5. eject_pilot() distributes THE VESTING PDA BALANCE with penalty:
//!        With referrer:    93.5% pool | 1.0% oracle | 2.0% referrer | 2.0% architect | 1.5% escrow
//!        Without referrer: 95.5% pool | 1.0% oracle |               | 2.0% architect | 1.5% escrow
//!
//!   6. Games use a separate bankroll_vault. Losses: 50% pool, 2% architect, 48% bankroll.
//!
//! ─── MISSION ISOLATION ───────────────────────────────────────────────────────
//!   When a mission starts, XNT is transferred from reward_vault to the VestingAccount PDA.
//!   The PDA belongs exclusively to the pilot (seeds = [b"vesting", player_pubkey]).
//!   No other mission, instruction, or account can withdraw lamports from this PDA.
//!   The balance is protected by the SVM runtime — only this program's instructions
//!   with the correct seeds can move it.
//!
//! ─── NFT ARTIFACTS (PHASE 2) ─────────────────────────────────────────────────
//!   V1 STATE: nft_boost_bps is ALWAYS 0 in this phase. The infrastructure is in
//!   place (VestingAccount field, validation, event), but on-chain verification of
//!   X1 Artifacts requires the MoonArtifacts Anchor program (Phase 2 — pending).
//!
//!   PHASE 2: When MoonArtifacts is deployed on X1, the oracle will read
//!   holders on-chain and include the boost in the `amount` of the Merkle leaf.
//!   The `nft_boost_bps` field documents which boost was applied for auditing.
//!
//!   NFT Artifact tiers (future — Phase 2):
//!     Lunar Dust    (600 NFTs): +5%   → nft_boost_bps = 500
//!     Cosmic Shard  (300 NFTs): +10%  → nft_boost_bps = 1000
//!     Solar Core    ( 90 NFTs): +20%  → nft_boost_bps = 2000
//!     Void Anomaly  ( 10 NFTs): +50%  → nft_boost_bps = 5000
//!     No Artifact (current V1) : +0%  → nft_boost_bps = 0
//!
//! ─── MERKLE LEAF (must match oracle/src/services/merkleGenerator.ts) ─────────
//!   leaf = keccak256(pubkey_32bytes || amount_8bytes_LE || tier_1byte)
//!   pubkey : raw 32-byte Solana PublicKey
//!   amount : u64 little-endian (lamports, NFT boost already included)
//!   tier   : u8 (0=Launchpad, 1=Orbit, 2=Moon Landing)
//!
//! ─── REDEPLOYMENT ────────────────────────────────────────────────────────────
//!   Already deployed. To redeploy from scratch:
//!   1. anchor build
//!   2. solana address -k target/deploy/moon_forge_games-keypair.json
//!   3. Update declare_id!() with new program ID
//!   4. anchor build  (rebuild with real ID)
//!   5. anchor deploy --provider.cluster https://rpc.mainnet.x1.xyz
//!   6. Call initialize_protocol() with architect pubkey and oracle pubkey
//!   7. Update X1_PROGRAM_ID in oracle/.env
//!   8. Compute discriminator for x1Publisher.ts:
//!        node -e "const c=require('crypto'); \
//!          console.log(Array.from(c.createHash('sha256') \
//!            .update('global:update_merkle_root').digest().slice(0,8)));"

use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    system_instruction,
    program::invoke,
};
use sha3::{Keccak256, Digest};

// ── Deployed program ID (X1 mainnet) ─────────────────────────────────────────
declare_id!("57UE1U1t23ztg2noLp8pcpGW1B1Xw25rLH6ra9Mchea9");

// ═══════════════════════════════════════════════════════════════════════════
//                         FEE CONSTANTS (BPS)
// ═══════════════════════════════════════════════════════════════════════════

const POOL_SHARE_BPS: u64        = 9350; // 93.5% pool (with referrer)
const NO_REF_POOL_SHARE_BPS: u64 = 9550; // 95.5% pool (no referrer)
const ORACLE_SHARE_BPS: u64      = 100;  //  1.0% oracle
const REF_SHARE_BPS: u64         = 200;  //  2.0% referrer
const ARCHITECT_SHARE_BPS: u64   = 200;  //  2.0% architect (dev wallet)
const ESCROW_SHARE_BPS: u64      = 150;  //  1.5% dev_escrow

const BPS_BASE: u64 = 10000;

// ═══════════════════════════════════════════════════════════════════════════
//                         TIER CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════

const TIER_0_DURATION: i64    = 5   * 24 * 60 * 60; // 5 days
const TIER_1_DURATION: i64    = 45  * 24 * 60 * 60; // 45 days
const TIER_2_DURATION: i64    = 180 * 24 * 60 * 60; // 180 days

const TIER_0_PENALTY_BPS: u64 = 0;     //  0% — Launchpad (no penalty)
const TIER_1_PENALTY_BPS: u64 = 2000;  // 20% — Orbit
const TIER_2_PENALTY_BPS: u64 = 5000;  // 50% — Moon Landing

// Valid NFT Artifact boosts (in BPS). Stored for audit trail.
const VALID_NFT_BOOSTS: [u16; 5] = [0, 500, 1000, 2000, 5000];

// ═══════════════════════════════════════════════════════════════════════════
//                         DEV ESCROW
// ═══════════════════════════════════════════════════════════════════════════

const ESCROW_RELEASE_EPOCHS: u64 = 4;    // 4-epoch cycle
const ESCROW_GROWTH_BPS: u64     = 9500; // requires 95% growth vs previous cycle

// ═══════════════════════════════════════════════════════════════════════════
//                         GAMES
// ═══════════════════════════════════════════════════════════════════════════

const MIN_BET: u64                = 1_000_000; // 0.001 XNT
const MAX_BET_BPS_OF_BANKROLL: u64 = 200;      // máx 2% do bankroll por aposta
const GAME_POOL_SUBSIDY_BPS: u64  = 5000;      // 50% das perdas → reward_vault (subsídio)
const GAME_ARCHITECT_BPS: u64     = 200;       //  2% das perdas → architect

// ═══════════════════════════════════════════════════════════════════════════
//                              PROGRAMA
// ═══════════════════════════════════════════════════════════════════════════

#[program]
pub mod moon_forge_games {
    use super::*;

    // ───────────────────────────────────────────────────────────────────────
    //  INICIALIZAÇÃO — chamada UMA VEZ após deploy
    // ───────────────────────────────────────────────────────────────────────

    /// Inicializa o estado global do protocolo.
    ///
    /// architect : tua carteira X1 (Base58 pubkey) — recebe 2% de penalidades em XNT.
    ///             Imutável após esta chamada — nunca pode ser alterado.
    /// oracle    : carteira do oracle no X1 — recebe 1% de penalidades.
    ///             Deve ser o pubkey correspondente a ORACLE_PRIVATE_KEY no oracle/.env.
    pub fn initialize_protocol(
        ctx: Context<InitializeProtocol>,
        architect: Pubkey,
        oracle: Pubkey,
    ) -> Result<()> {
        let state = &mut ctx.accounts.state;
        state.architect        = architect;
        state.oracle           = oracle;
        state.merkle_root      = [0u8; 32];
        state.current_epoch    = 0;
        state.cycle_volume     = 0;
        state.prev_cycle_volume = 0;
        state.epochs_in_cycle  = 0;
        state.bump             = ctx.bumps.state;
        Ok(())
    }

    // ───────────────────────────────────────────────────────────────────────
    //  ORACLE: ATUALIZAR MERKLE ROOT
    // ───────────────────────────────────────────────────────────────────────

    /// Publicar nova Merkle root — somente o oracle pode chamar.
    ///
    /// Discriminador (copiar para x1Publisher.ts após anchor build):
    ///   node -e "const c=require('crypto'); \
    ///     console.log(Array.from(c.createHash('sha256') \
    ///       .update('global:update_merkle_root').digest().slice(0,8)));"
    pub fn update_merkle_root(
        ctx: Context<UpdateRoot>,
        new_root: [u8; 32],
        new_epoch: u64,
    ) -> Result<()> {
        let state = &mut ctx.accounts.state;
        require!(ctx.accounts.signer.key() == state.oracle, ForgeError::OnlyOracle);
        require!(new_epoch > state.current_epoch, ForgeError::OldEpoch);

        // Rastreia volume por ciclo para DevEscrow
        state.epochs_in_cycle += 1;
        if state.epochs_in_cycle >= ESCROW_RELEASE_EPOCHS {
            state.prev_cycle_volume = state.cycle_volume;
            state.cycle_volume      = 0;
            state.epochs_in_cycle   = 0;
        }

        state.current_epoch = new_epoch;
        state.merkle_root   = new_root;

        emit!(EpochUpdated { epoch: new_epoch, root: new_root });
        Ok(())
    }

    // ───────────────────────────────────────────────────────────────────────
    //  CLAIM + INICIAR MISSÃO (UM ÚNICO PASSO — XNT ISOLADO NO VESTING PDA)
    // ───────────────────────────────────────────────────────────────────────

    /// Verificar prova Merkle, transferir XNT para o VestingAccount PDA do piloto,
    /// e iniciar o período de vesting — tudo em uma única transação.
    ///
    /// ISOLAMENTO: O XNT é transferido do reward_vault para o VestingAccount PDA
    /// exclusivo deste piloto. A partir deste momento:
    ///   - O XNT desta missão pertence exclusivamente ao piloto
    ///   - Nenhuma outra missão pode tocar neste saldo
    ///   - Protegido pelo runtime SVM via seeds do PDA
    ///
    /// nft_boost_bps: boost do NFT Artifact usado nesta queima (informacional):
    ///   0     = sem NFT Artifact
    ///   500   = Lunar Dust (+5%)
    ///   1000  = Cosmic Shard (+10%)
    ///   2000  = Solar Core (+20%)
    ///   5000  = Void Anomaly (+50%)
    ///   O boost já está embutido no `amount` da prova Merkle pelo oracle.
    ///   Este campo é armazenado apenas para auditoria transparente on-chain.
    pub fn claim_and_start_mission(
        ctx: Context<ClaimAndStartMission>,
        proof: Vec<[u8; 32]>,
        epoch: u64,
        amount: u64,
        tier: u8,
        referrer: Option<Pubkey>,
        nft_boost_bps: u16,
    ) -> Result<()> {
        require!(tier <= 2, ForgeError::InvalidTier);
        require!(epoch <= ctx.accounts.state.current_epoch, ForgeError::FutureEpoch);
        require!(
            VALID_NFT_BOOSTS.contains(&nft_boost_bps),
            ForgeError::InvalidNftBoost
        );

        // ── Reconstrução do leaf ────────────────────────────────────────────
        // Formato: keccak256(pubkey_32bytes || amount_8bytes_LE || tier_1byte)
        // Deve ser idêntico ao oracle/src/services/merkleGenerator.ts → generateLeaf()
        let mut data = Vec::with_capacity(41);
        data.extend_from_slice(&ctx.accounts.player.key().to_bytes()); // 32 bytes
        data.extend_from_slice(&amount.to_le_bytes());                  //  8 bytes u64 LE
        data.push(tier);                                                //  1 byte
        let leaf: [u8; 32] = Keccak256::digest(&data).into();

        // ── Verificar prova Merkle ──────────────────────────────────────────
        require!(
            verify_merkle_proof(proof, ctx.accounts.state.merkle_root, leaf),
            ForgeError::InvalidProof
        );

        // ── Verificar saldo do reward_vault ────────────────────────────────
        require!(ctx.accounts.reward_vault.lamports() >= amount, ForgeError::VaultDry);

        // ── Registrar receipt (anti-replay por epoch + player) ──────────────
        let receipt = &mut ctx.accounts.receipt;
        receipt.player     = ctx.accounts.player.key();
        receipt.epoch      = epoch;
        receipt.claimed_at = Clock::get()?.unix_timestamp;

        // ── Transferir XNT: reward_vault → VestingAccount PDA ───────────────
        // A partir daqui, o XNT pertence exclusivamente a este piloto.
        // O saldo do VestingAccount PDA é o "cofre pessoal" da missão.
        **ctx.accounts.reward_vault.to_account_info().try_borrow_mut_lamports()? -= amount;
        **ctx.accounts.vesting.to_account_info().try_borrow_mut_lamports()? += amount;

        // ── Criar registo de vesting ────────────────────────────────────────
        let clock    = Clock::get()?;
        let duration = match tier {
            0 => TIER_0_DURATION,
            1 => TIER_1_DURATION,
            _ => TIER_2_DURATION,
        };

        let vesting = &mut ctx.accounts.vesting;
        vesting.player         = ctx.accounts.player.key();
        vesting.total_amount   = amount;
        vesting.claimed_amount = 0;
        vesting.start_time     = clock.unix_timestamp;
        vesting.end_time       = clock.unix_timestamp + duration;
        vesting.tier           = tier;
        vesting.referrer       = referrer;
        vesting.nft_boost_bps  = nft_boost_bps;
        vesting.initialized    = true;
        vesting.bump           = ctx.bumps.vesting;

        // Rastrear volume do ciclo para DevEscrow
        ctx.accounts.state.cycle_volume += amount;

        emit!(MissionStarted {
            player:        ctx.accounts.player.key(),
            epoch,
            amount,
            tier,
            nft_boost_bps,
            end_time:      vesting.end_time,
        });
        Ok(())
    }

    // ───────────────────────────────────────────────────────────────────────
    //  SACAR XNT VESTED (LINEAR — DO VESTING PDA EXCLUSIVO)
    // ───────────────────────────────────────────────────────────────────────

    /// Sacar XNT que já vestiu linearmente. Retira EXCLUSIVAMENTE do
    /// VestingAccount PDA deste piloto — nunca do saldo de outra missão.
    ///
    /// Pode ser chamado várias vezes. Quando 100% vester, a conta é fechada
    /// e o rent é devolvido ao piloto.
    pub fn claim_vested(ctx: Context<ClaimVested>) -> Result<()> {
        let clock = Clock::get()?;

        // Ler dados necessários antes de borrow mutável
        let claimable = {
            let v = &ctx.accounts.vesting;
            require!(v.initialized, ForgeError::NoMission);
            get_claimable(v, clock.unix_timestamp)
        };
        require!(claimable > 0, ForgeError::NothingClaimable);

        ctx.accounts.vesting.claimed_amount += claimable;
        let mission_complete =
            ctx.accounts.vesting.claimed_amount >= ctx.accounts.vesting.total_amount;

        if mission_complete {
            // Missão 100% concluída — encerrar o PDA completamente.
            // Transfere TODOS os lamports (XNT restante + rent) para o piloto.
            // O SVM remove automaticamente contas com saldo 0.
            // Na próxima missão, init_if_needed recria o PDA limpo.
            ctx.accounts.vesting.initialized = false;
            let all_lamports = ctx.accounts.vesting.to_account_info().lamports();
            **ctx.accounts.vesting.to_account_info().try_borrow_mut_lamports()? -= all_lamports;
            **ctx.accounts.player.to_account_info().try_borrow_mut_lamports()? += all_lamports;
        } else {
            // Saque parcial — transfere apenas os lamports vested desta vez.
            **ctx.accounts.vesting.to_account_info().try_borrow_mut_lamports()? -= claimable;
            **ctx.accounts.player.to_account_info().try_borrow_mut_lamports()? += claimable;
        }

        emit!(VestedClaimed { player: ctx.accounts.player.key(), amount: claimable });
        Ok(())
    }

    // ───────────────────────────────────────────────────────────────────────
    //  EJETAR PILOTO (SAÍDA ANTECIPADA — DISTRIBUI DO VESTING PDA)
    // ───────────────────────────────────────────────────────────────────────

    /// Sair da missão antes do término. Distribui o saldo RESTANTE do
    /// VestingAccount PDA com penalidade. O VestingAccount é esvaziado.
    ///
    /// Tier 0: sem penalidade — total devolvido ao piloto
    /// Tier 1: 20% de penalidade sobre o restante não sacado
    /// Tier 2: 50% de penalidade sobre o restante não sacado
    ///
    /// Distribuição da penalidade:
    ///   Com referrer:    93.5% reward_vault | 1.0% oracle | 2.0% referrer |
    ///                    2.0% architect | 1.5% dev_escrow
    ///   Sem referrer:    95.5% reward_vault | 1.0% oracle |
    ///                    2.0% architect | 1.5% dev_escrow
    pub fn eject_pilot(ctx: Context<EjectPilot>) -> Result<()> {
        let vesting = &ctx.accounts.vesting;
        require!(vesting.initialized, ForgeError::NoMission);

        let remaining   = vesting.total_amount - vesting.claimed_amount;
        let penalty_bps = match vesting.tier {
            0 => TIER_0_PENALTY_BPS,
            1 => TIER_1_PENALTY_BPS,
            _ => TIER_2_PENALTY_BPS,
        };
        let has_referrer = vesting.referrer.is_some();
        let stored_referrer = vesting.referrer;
        let stored_tier = vesting.tier;

        let penalty     = (remaining * penalty_bps) / BPS_BASE;
        let user_return = remaining - penalty;

        // Garantir que o VestingAccount PDA tem saldo suficiente
        // (deve ter exatamente `remaining` em lamports relativos à missão)
        require!(ctx.accounts.vesting.to_account_info().lamports() >= remaining, ForgeError::VaultDry);

        // ── Distribuir penalidade do VestingAccount PDA ─────────────────────
        if penalty > 0 {
            let oracle_share    = (penalty * ORACLE_SHARE_BPS) / BPS_BASE;
            let architect_share = (penalty * ARCHITECT_SHARE_BPS) / BPS_BASE;
            let escrow_share    = (penalty * ESCROW_SHARE_BPS) / BPS_BASE;

            let ref_share = if has_referrer {
                (penalty * REF_SHARE_BPS) / BPS_BASE
            } else {
                0u64
            };

            // Pool share: o que sobra da penalidade vai de volta ao reward_vault
            // Com ref:    penalty - oracle - architect - escrow - ref  = 93.5%
            // Sem ref:    penalty - oracle - architect - escrow        = 95.5%
            let pool_share = penalty - oracle_share - architect_share - escrow_share - ref_share;

            // 1.0% → oracle
            if oracle_share > 0 {
                **ctx.accounts.vesting.to_account_info().try_borrow_mut_lamports()? -= oracle_share;
                **ctx.accounts.oracle_wallet.to_account_info().try_borrow_mut_lamports()? += oracle_share;
            }
            // 2.0% → referrer (se houver)
            if ref_share > 0 {
                require!(
                    ctx.accounts.referrer_wallet.key() == stored_referrer.unwrap(),
                    ForgeError::InvalidReferrer
                );
                **ctx.accounts.vesting.to_account_info().try_borrow_mut_lamports()? -= ref_share;
                **ctx.accounts.referrer_wallet.to_account_info().try_borrow_mut_lamports()? += ref_share;
            }
            // 2.0% → architect (tua carteira X1)
            if architect_share > 0 {
                **ctx.accounts.vesting.to_account_info().try_borrow_mut_lamports()? -= architect_share;
                **ctx.accounts.architect_wallet.to_account_info().try_borrow_mut_lamports()? += architect_share;
            }
            // 1.5% → dev_escrow_vault
            if escrow_share > 0 {
                **ctx.accounts.vesting.to_account_info().try_borrow_mut_lamports()? -= escrow_share;
                **ctx.accounts.dev_escrow_vault.to_account_info().try_borrow_mut_lamports()? += escrow_share;
            }
            // 93.5% / 95.5% → reward_vault (volta ao pool)
            if pool_share > 0 {
                **ctx.accounts.vesting.to_account_info().try_borrow_mut_lamports()? -= pool_share;
                **ctx.accounts.reward_vault.to_account_info().try_borrow_mut_lamports()? += pool_share;
            }
        }

        // ── Devolver a parte do usuário ─────────────────────────────────────
        if user_return > 0 {
            **ctx.accounts.vesting.to_account_info().try_borrow_mut_lamports()? -= user_return;
            **ctx.accounts.player.to_account_info().try_borrow_mut_lamports()? += user_return;
        }

        ctx.accounts.vesting.initialized = false;

        // Devolver rent residual ao piloto — garante que o PDA esvazie completamente.
        // O SVM remove contas com saldo 0; init_if_needed recria na próxima missão.
        let leftover = ctx.accounts.vesting.to_account_info().lamports();
        if leftover > 0 {
            **ctx.accounts.vesting.to_account_info().try_borrow_mut_lamports()? -= leftover;
            **ctx.accounts.player.to_account_info().try_borrow_mut_lamports()? += leftover;
        }

        emit!(PilotEjected {
            player:    ctx.accounts.player.key(),
            tier:      stored_tier,
            penalty,
            returned:  user_return,
        });
        Ok(())
    }

    // ───────────────────────────────────────────────────────────────────────
    //  DONATE — qualquer um pode adicionar XNT ao reward_vault
    // ───────────────────────────────────────────────────────────────────────

    /// Doação direta ao reward_vault. 100% vai para o pool de recompensas.
    /// Chamado automaticamente pelo oracle quando seu saldo > 25 XNT.
    pub fn donate(ctx: Context<Donate>, amount: u64) -> Result<()> {
        require!(amount > 0, ForgeError::InvalidAmount);
        invoke(
            &system_instruction::transfer(
                &ctx.accounts.donor.key(),
                &ctx.accounts.reward_vault.key(),
                amount,
            ),
            &[
                ctx.accounts.donor.to_account_info(),
                ctx.accounts.reward_vault.to_account_info(),
            ],
        )?;
        emit!(Donated { donor: ctx.accounts.donor.key(), amount });
        Ok(())
    }

    // ───────────────────────────────────────────────────────────────────────
    //  RELEASE DEV ESCROW — liberar ao pool se protocolo cresceu
    // ───────────────────────────────────────────────────────────────────────

    /// Permissionless — qualquer um pode chamar após 4 épocas.
    /// Se volume do ciclo atual >= 95% do ciclo anterior → libera escrow ao pool.
    /// Se crescimento abaixo de 95% → escrow permanece bloqueado.
    pub fn release_dev_escrow(ctx: Context<ReleaseDevEscrow>) -> Result<()> {
        let state = &ctx.accounts.state;
        require!(state.prev_cycle_volume > 0, ForgeError::NoEscrowCycle);

        let threshold  = (state.prev_cycle_volume * ESCROW_GROWTH_BPS) / BPS_BASE;
        let escrow_bal = ctx.accounts.dev_escrow_vault.lamports();
        require!(escrow_bal > 0, ForgeError::NoEscrowBalance);

        if state.cycle_volume >= threshold {
            **ctx.accounts.dev_escrow_vault.to_account_info().try_borrow_mut_lamports()? -= escrow_bal;
            **ctx.accounts.reward_vault.to_account_info().try_borrow_mut_lamports()? += escrow_bal;
            emit!(EscrowReleased { amount: escrow_bal, to_pool: true });
        }
        Ok(())
    }

    // ───────────────────────────────────────────────────────────────────────
    //  JOGO: COIN FLIP
    // ───────────────────────────────────────────────────────────────────────

    /// Cara (0) ou coroa (1). Vitória: 1.96× retira do bankroll_vault.
    /// Derrota: 50% → reward_vault (subsídio burners), 2% → architect, 48% → bankroll.
    /// bankroll_vault e reward_vault são separados das missões — sem conflito.
    pub fn coin_flip(ctx: Context<PlayGame>, side: u8, amount: u64) -> Result<()> {
        require!(side <= 1, ForgeError::InvalidInput);
        require!(amount >= MIN_BET, ForgeError::BetTooLow);
        let max_bet = (ctx.accounts.bankroll_vault.lamports() * MAX_BET_BPS_OF_BANKROLL) / BPS_BASE;
        require!(amount <= max_bet, ForgeError::BetTooHigh);

        invoke(
            &system_instruction::transfer(
                &ctx.accounts.player.key(),
                &ctx.accounts.bankroll_vault.key(),
                amount,
            ),
            &[
                ctx.accounts.player.to_account_info(),
                ctx.accounts.bankroll_vault.to_account_info(),
            ],
        )?;

        let clock  = Clock::get()?;
        let seed: [u8; 32] = Keccak256::digest(&ctx.accounts.player.key().to_bytes()).into();
        let mixed: Vec<u8> = clock.slot.to_le_bytes().iter()
            .zip(seed.iter()).map(|(a, b)| a ^ b).collect();
        let result = mixed[0] % 2;

        if side == result {
            let payout = (amount * 19600) / 10000; // 1.96×
            require!(ctx.accounts.bankroll_vault.lamports() >= payout, ForgeError::VaultDry);
            **ctx.accounts.bankroll_vault.to_account_info().try_borrow_mut_lamports()? -= payout;
            **ctx.accounts.player.to_account_info().try_borrow_mut_lamports()? += payout;
        } else {
            let subsidy  = (amount * GAME_POOL_SUBSIDY_BPS) / BPS_BASE;
            let arch_fee = (amount * GAME_ARCHITECT_BPS) / BPS_BASE;
            **ctx.accounts.bankroll_vault.to_account_info().try_borrow_mut_lamports()? -= subsidy + arch_fee;
            **ctx.accounts.reward_vault.to_account_info().try_borrow_mut_lamports()? += subsidy;
            **ctx.accounts.architect_wallet.to_account_info().try_borrow_mut_lamports()? += arch_fee;
        }
        Ok(())
    }

    // ───────────────────────────────────────────────────────────────────────
    //  JOGO: ADIVINHAR NÚMERO (HIGH / LOW)
    // ───────────────────────────────────────────────────────────────────────

    /// Número secreto (1-100). guess_high=true → aposta que é > 50.
    /// Vitória: 1.94×. Derrota: 50% pool, 2% architect, 48% bankroll.
    pub fn number_guess(ctx: Context<PlayGame>, guess_high: bool, amount: u64) -> Result<()> {
        require!(amount >= MIN_BET, ForgeError::BetTooLow);
        let max_bet = (ctx.accounts.bankroll_vault.lamports() * MAX_BET_BPS_OF_BANKROLL) / BPS_BASE;
        require!(amount <= max_bet, ForgeError::BetTooHigh);

        invoke(
            &system_instruction::transfer(
                &ctx.accounts.player.key(),
                &ctx.accounts.bankroll_vault.key(),
                amount,
            ),
            &[
                ctx.accounts.player.to_account_info(),
                ctx.accounts.bankroll_vault.to_account_info(),
            ],
        )?;

        let clock  = Clock::get()?;
        let seed: [u8; 32] = Keccak256::digest(&ctx.accounts.player.key().to_bytes()).into();
        let mixed: Vec<u8> = clock.slot.to_le_bytes().iter()
            .zip(seed.iter()).map(|(a, b)| a ^ b).collect();
        let number = (mixed[0] % 100) + 1; // 1..=100

        let won = if guess_high { number > 50 } else { number <= 50 };

        if won {
            let payout = (amount * 19400) / 10000; // 1.94×
            require!(ctx.accounts.bankroll_vault.lamports() >= payout, ForgeError::VaultDry);
            **ctx.accounts.bankroll_vault.to_account_info().try_borrow_mut_lamports()? -= payout;
            **ctx.accounts.player.to_account_info().try_borrow_mut_lamports()? += payout;
        } else {
            let subsidy  = (amount * GAME_POOL_SUBSIDY_BPS) / BPS_BASE;
            let arch_fee = (amount * GAME_ARCHITECT_BPS) / BPS_BASE;
            **ctx.accounts.bankroll_vault.to_account_info().try_borrow_mut_lamports()? -= subsidy + arch_fee;
            **ctx.accounts.reward_vault.to_account_info().try_borrow_mut_lamports()? += subsidy;
            **ctx.accounts.architect_wallet.to_account_info().try_borrow_mut_lamports()? += arch_fee;
        }
        Ok(())
    }

    // ───────────────────────────────────────────────────────────────────────
    //  JOGO: JACKPOT
    // ───────────────────────────────────────────────────────────────────────

    /// ~1.95% de chance de ganhar 10× a aposta.
    /// Derrota: 50% pool, 2% architect, 48% bankroll.
    pub fn jackpot(ctx: Context<PlayGame>, amount: u64) -> Result<()> {
        require!(amount >= MIN_BET, ForgeError::BetTooLow);
        let max_bet = (ctx.accounts.bankroll_vault.lamports() * 50) / BPS_BASE; // 0.5%
        require!(amount <= max_bet, ForgeError::BetTooHigh);

        invoke(
            &system_instruction::transfer(
                &ctx.accounts.player.key(),
                &ctx.accounts.bankroll_vault.key(),
                amount,
            ),
            &[
                ctx.accounts.player.to_account_info(),
                ctx.accounts.bankroll_vault.to_account_info(),
            ],
        )?;

        let clock  = Clock::get()?;
        let seed: [u8; 32] = Keccak256::digest(&ctx.accounts.player.key().to_bytes()).into();
        let mixed: Vec<u8> = clock.slot.to_le_bytes().iter()
            .zip(seed.iter()).map(|(a, b)| a ^ b).collect();

        if mixed[0] < 5 { // ~1.95% (5/256)
            let payout = amount * 10;
            require!(ctx.accounts.bankroll_vault.lamports() >= payout, ForgeError::VaultDry);
            **ctx.accounts.bankroll_vault.to_account_info().try_borrow_mut_lamports()? -= payout;
            **ctx.accounts.player.to_account_info().try_borrow_mut_lamports()? += payout;
        } else {
            let subsidy  = (amount * GAME_POOL_SUBSIDY_BPS) / BPS_BASE;
            let arch_fee = (amount * GAME_ARCHITECT_BPS) / BPS_BASE;
            **ctx.accounts.bankroll_vault.to_account_info().try_borrow_mut_lamports()? -= subsidy + arch_fee;
            **ctx.accounts.reward_vault.to_account_info().try_borrow_mut_lamports()? += subsidy;
            **ctx.accounts.architect_wallet.to_account_info().try_borrow_mut_lamports()? += arch_fee;
        }
        Ok(())
    }
}

// ═══════════════════════════════════════════════════════════════════════════
//                         CONTEXTOS DE CONTA
// ═══════════════════════════════════════════════════════════════════════════

#[derive(Accounts)]
pub struct InitializeProtocol<'info> {
    #[account(init, payer = payer, space = ProtocolState::SIZE, seeds = [b"protocol_state"], bump)]
    pub state: Account<'info, ProtocolState>,
    /// CHECK: reward_vault — PDA lamport vault (seeds: reward_vault). Owned by this program.
    #[account(init, payer = payer, space = 8, seeds = [b"reward_vault"], bump)]
    pub reward_vault: UncheckedAccount<'info>,
    /// CHECK: bankroll_vault — PDA lamport vault for games (seeds: bankroll_vault). Owned by this program.
    #[account(init, payer = payer, space = 8, seeds = [b"bankroll_vault"], bump)]
    pub bankroll_vault: UncheckedAccount<'info>,
    /// CHECK: dev_escrow_vault — PDA lamport vault (seeds: dev_escrow). Owned by this program.
    #[account(init, payer = payer, space = 8, seeds = [b"dev_escrow"], bump)]
    pub dev_escrow_vault: UncheckedAccount<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateRoot<'info> {
    #[account(mut, seeds = [b"protocol_state"], bump = state.bump)]
    pub state: Account<'info, ProtocolState>,
    pub signer: Signer<'info>,
}

#[derive(Accounts)]
#[instruction(proof: Vec<[u8; 32]>, epoch: u64, amount: u64, tier: u8, referrer: Option<Pubkey>, nft_boost_bps: u16)]
pub struct ClaimAndStartMission<'info> {
    #[account(mut, seeds = [b"protocol_state"], bump = state.bump)]
    pub state: Account<'info, ProtocolState>,

    #[account(mut)]
    pub player: Signer<'info>,

    /// CHECK: reward_vault — PDA lamport vault. Seeds validated by constraint.
    #[account(mut, seeds = [b"reward_vault"], bump)]
    pub reward_vault: UncheckedAccount<'info>,

    /// ClaimReceipt PDA por (epoch, player) — impede duplo-claim da mesma época
    #[account(
        init,
        payer = player,
        space = ClaimReceipt::SIZE,
        seeds = [b"claim_receipt", epoch.to_le_bytes().as_ref(), player.key().as_ref()],
        bump
    )]
    pub receipt: Account<'info, ClaimReceipt>,

    /// VestingAccount PDA exclusivo do piloto — recebe e guarda o XNT desta missão.
    /// Seeds = [b"vesting", player_pubkey] → único por piloto → uma missão ativa por vez.
    ///
    /// NOTA: Requer feature "init-if-needed" no Cargo.toml do programa:
    ///   anchor-lang = { version = "0.30.1", features = ["init-if-needed"] }
    ///
    /// Na PRIMEIRA missão o PDA é criado (init). Em missões SUBSEQUENTES o PDA
    /// já existe (com initialized=false após missão anterior terminar) e é reutilizado.
    /// A constraint `!vesting.initialized` impede double-missão simultânea.
    #[account(
        init_if_needed,
        payer = player,
        space = VestingAccount::SIZE,
        seeds = [b"vesting", player.key().as_ref()],
        bump,
        constraint = !vesting.initialized @ ForgeError::ActiveMission
    )]
    pub vesting: Account<'info, VestingAccount>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ClaimVested<'info> {
    #[account(seeds = [b"protocol_state"], bump = state.bump)]
    pub state: Account<'info, ProtocolState>,
    #[account(mut)]
    pub player: Signer<'info>,
    /// O XNT sai do VestingAccount PDA exclusivo do piloto — não do reward_vault compartilhado
    #[account(
        mut,
        seeds = [b"vesting", player.key().as_ref()],
        bump = vesting.bump,
        constraint = vesting.player == player.key() @ ForgeError::NotYourMission
    )]
    pub vesting: Account<'info, VestingAccount>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct EjectPilot<'info> {
    #[account(seeds = [b"protocol_state"], bump = state.bump)]
    pub state: Account<'info, ProtocolState>,
    #[account(mut)]
    pub player: Signer<'info>,
    /// O saldo restante desta missão sai do VestingAccount PDA exclusivo
    #[account(
        mut,
        seeds = [b"vesting", player.key().as_ref()],
        bump = vesting.bump,
        constraint = vesting.player == player.key() @ ForgeError::NotYourMission
    )]
    pub vesting: Account<'info, VestingAccount>,
    /// CHECK: reward_vault — PDA lamport vault. Seeds validated by constraint.
    #[account(mut, seeds = [b"reward_vault"], bump)]
    pub reward_vault: UncheckedAccount<'info>,
    /// CHECK: dev_escrow_vault — PDA lamport vault. Seeds validated by constraint.
    #[account(mut, seeds = [b"dev_escrow"], bump)]
    pub dev_escrow_vault: UncheckedAccount<'info>,
    /// CHECK: validado contra state.oracle na instrução
    #[account(mut, constraint = oracle_wallet.key() == state.oracle @ ForgeError::OnlyOracle)]
    pub oracle_wallet: UncheckedAccount<'info>,
    /// CHECK: validado contra state.architect na instrução
    #[account(mut, constraint = architect_wallet.key() == state.architect @ ForgeError::InvalidArchitect)]
    pub architect_wallet: UncheckedAccount<'info>,
    /// CHECK: validado contra vesting.referrer dentro da instrução
    #[account(mut)]
    pub referrer_wallet: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Donate<'info> {
    #[account(mut)]
    pub donor: Signer<'info>,
    /// CHECK: reward_vault — PDA lamport vault. Seeds validated by constraint.
    #[account(mut, seeds = [b"reward_vault"], bump)]
    pub reward_vault: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ReleaseDevEscrow<'info> {
    #[account(seeds = [b"protocol_state"], bump = state.bump)]
    pub state: Account<'info, ProtocolState>,
    /// CHECK: dev_escrow_vault — PDA lamport vault. Seeds validated by constraint.
    #[account(mut, seeds = [b"dev_escrow"], bump)]
    pub dev_escrow_vault: UncheckedAccount<'info>,
    /// CHECK: reward_vault — PDA lamport vault. Seeds validated by constraint.
    #[account(mut, seeds = [b"reward_vault"], bump)]
    pub reward_vault: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct PlayGame<'info> {
    #[account(mut, seeds = [b"protocol_state"], bump = state.bump)]
    pub state: Account<'info, ProtocolState>,
    #[account(mut)]
    pub player: Signer<'info>,
    /// CHECK: bankroll_vault — PDA lamport vault for games. Seeds validated by constraint.
    #[account(mut, seeds = [b"bankroll_vault"], bump)]
    pub bankroll_vault: UncheckedAccount<'info>,
    /// CHECK: reward_vault — PDA lamport vault. Seeds validated by constraint.
    #[account(mut, seeds = [b"reward_vault"], bump)]
    pub reward_vault: UncheckedAccount<'info>,
    /// CHECK: validado contra state.architect
    #[account(mut, constraint = architect_wallet.key() == state.architect @ ForgeError::InvalidArchitect)]
    pub architect_wallet: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

// ═══════════════════════════════════════════════════════════════════════════
//                         STRUCTS DE CONTA
// ═══════════════════════════════════════════════════════════════════════════

#[account]
pub struct ProtocolState {
    pub architect: Pubkey,        // 32 — tua carteira X1 (recebe 2% penalidades em XNT)
    pub oracle: Pubkey,           // 32 — oracle wallet (recebe 1% penalidades)
    pub merkle_root: [u8; 32],    // 32 — root da época atual
    pub current_epoch: u64,       //  8
    pub cycle_volume: u64,        //  8 — XNT alocado no ciclo atual (4 épocas)
    pub prev_cycle_volume: u64,   //  8 — XNT alocado no ciclo anterior
    pub epochs_in_cycle: u64,     //  8 — contador de épocas no ciclo atual
    pub bump: u8,                 //  1
}
impl ProtocolState {
    pub const SIZE: usize = 8 + 32 + 32 + 32 + 8 + 8 + 8 + 8 + 1;
}

#[account]
pub struct VestingAccount {
    pub player: Pubkey,           // 32 — dono desta missão (único que pode interagir)
    pub total_amount: u64,        //  8 — XNT total desta missão (lamports, inclui boost NFT)
    pub claimed_amount: u64,      //  8 — XNT já sacado via claim_vested
    pub start_time: i64,          //  8 — timestamp de início do vesting
    pub end_time: i64,            //  8 — timestamp de término (vesting 100% completo)
    pub tier: u8,                 //  1 — 0=Launchpad, 1=Orbit, 2=Moon Landing
    pub nft_boost_bps: u16,       //  2 — boost NFT Artifact aplicado (0/500/1000/2000/5000)
    pub referrer: Option<Pubkey>, // 33 — referrer registrado (1 flag + 32 pubkey)
    pub initialized: bool,        //  1 — false = missão concluída ou ejeta
    pub bump: u8,                 //  1 — bump do PDA para assinar transferências
}
impl VestingAccount {
    pub const SIZE: usize = 8 + 32 + 8 + 8 + 8 + 8 + 1 + 2 + 33 + 1 + 1;
}

#[account]
pub struct ClaimReceipt {
    pub player: Pubkey,   // 32 — piloto que reivindicou
    pub epoch: u64,       //  8 — época reivindicada (impede duplo-claim)
    pub claimed_at: i64,  //  8 — timestamp
}
impl ClaimReceipt {
    pub const SIZE: usize = 8 + 32 + 8 + 8;
}

// ═══════════════════════════════════════════════════════════════════════════
//                              EVENTOS
// ═══════════════════════════════════════════════════════════════════════════

#[event]
pub struct EpochUpdated {
    pub epoch: u64,
    pub root:  [u8; 32],
}

#[event]
pub struct MissionStarted {
    pub player:        Pubkey,
    pub epoch:         u64,
    pub amount:        u64,   // XNT total (já inclui boost do NFT Artifact)
    pub tier:          u8,
    pub nft_boost_bps: u16,   // boost aplicado pelo oracle (auditável on-chain)
    pub end_time:      i64,
}

#[event]
pub struct VestedClaimed {
    pub player: Pubkey,
    pub amount: u64,
}

#[event]
pub struct PilotEjected {
    pub player:   Pubkey,
    pub tier:     u8,
    pub penalty:  u64,
    pub returned: u64,
}

#[event]
pub struct Donated {
    pub donor:  Pubkey,
    pub amount: u64,
}

#[event]
pub struct EscrowReleased {
    pub amount:  u64,
    pub to_pool: bool,
}

// ═══════════════════════════════════════════════════════════════════════════
//                              ERROS
// ═══════════════════════════════════════════════════════════════════════════

#[error_code]
pub enum ForgeError {
    #[msg("Apenas o oracle pode chamar esta instrução")]           OnlyOracle,
    #[msg("A época deve ser mais recente que a atual")]            OldEpoch,
    #[msg("Não pode reivindicar época futura")]                    FutureEpoch,
    #[msg("Prova Merkle inválida")]                               InvalidProof,
    #[msg("Saldo insuficiente no vault")]                         VaultDry,
    #[msg("Tier inválido — deve ser 0, 1 ou 2")]                  InvalidTier,
    #[msg("Boost de NFT inválido — use 0/500/1000/2000/5000")]    InvalidNftBoost,
    #[msg("Piloto já tem missão ativa")]                          ActiveMission,
    #[msg("Nenhuma missão ativa encontrada")]                     NoMission,
    #[msg("Nada para sacar ainda")]                               NothingClaimable,
    #[msg("Esta missão não pertence a você")]                     NotYourMission,
    #[msg("Aposta muito baixa (mínimo 0.001 XNT)")]               BetTooLow,
    #[msg("Aposta muito alta (limite 2% do bankroll)")]           BetTooHigh,
    #[msg("Input inválido")]                                      InvalidInput,
    #[msg("Carteira architect inválida")]                         InvalidArchitect,
    #[msg("Referrer não corresponde ao registrado")]              InvalidReferrer,
    #[msg("Valor deve ser maior que zero")]                       InvalidAmount,
    #[msg("Nenhum ciclo de escrow completado ainda")]             NoEscrowCycle,
    #[msg("DevEscrow vault está vazio")]                          NoEscrowBalance,
}

// ═══════════════════════════════════════════════════════════════════════════
//                              HELPERS
// ═══════════════════════════════════════════════════════════════════════════

/// Verificar prova Merkle com keccak256.
/// Pares ordenados antes do hash (sortPairs: true — igual ao merkletreejs do oracle).
fn verify_merkle_proof(proof: Vec<[u8; 32]>, root: [u8; 32], leaf: [u8; 32]) -> bool {
    let mut computed = leaf;
    for node in proof {
        computed = if computed <= node {
            Keccak256::digest([computed, node].concat().as_slice()).into()
        } else {
            Keccak256::digest([node, computed].concat().as_slice()).into()
        };
    }
    computed == root
}

/// Calcular XNT disponível para saque (vesting linear).
/// Retorna 0 se a missão não iniciou ou já foi totalmente sacada.
fn get_claimable(vesting: &VestingAccount, now: i64) -> u64 {
    if !vesting.initialized {
        return 0;
    }
    let remaining = vesting.total_amount.saturating_sub(vesting.claimed_amount);
    if now >= vesting.end_time {
        return remaining;
    }
    let duration = (vesting.end_time - vesting.start_time).max(1) as u64;
    let elapsed  = (now - vesting.start_time).max(0) as u64;
    let vested   = vesting.total_amount.saturating_mul(elapsed) / duration;
    vested.saturating_sub(vesting.claimed_amount)
}
