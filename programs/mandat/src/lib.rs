use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    self, Mint, TokenAccount, TokenInterface, TransferChecked,
};

declare_id!("2nJTE7vKVaV3pum9jV9NTYP3MPMqAx2GojqxFQn9W2kz");

pub const SECONDS_PER_DAY: i64 = 86_400;
pub const MAX_ALLOWED_DESTINATIONS: usize = 16;
/// Upper bound on how long a delegated session key may live.
pub const MAX_SESSION_DURATION: i64 = 30 * SECONDS_PER_DAY;

#[program]
pub mod mandat {
    use super::*;

    /// Create a vault owned by `owner` with an on-chain spending policy.
    pub fn initialize_vault(ctx: Context<InitializeVault>, args: PolicyArgs) -> Result<()> {
        args.validate()?;
        let vault = &mut ctx.accounts.vault;
        vault.owner = ctx.accounts.owner.key();
        vault.bump = ctx.bumps.vault;
        vault.frozen = false;
        vault.policy = Policy::from_args(&args);
        // Token path stays disabled until configure_token_policy.
        vault.token_policy = TokenPolicy::default();
        emit!(VaultInitialized {
            vault: vault.key(),
            owner: vault.owner,
        });
        Ok(())
    }

    /// Move SOL from the owner into the vault PDA.
    pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
        anchor_lang::system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.key(),
                anchor_lang::system_program::Transfer {
                    from: ctx.accounts.owner.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                },
            ),
            amount,
        )?;
        emit!(Deposited {
            vault: ctx.accounts.vault.key(),
            amount,
        });
        Ok(())
    }

    /// Owner-only withdrawal. Not subject to the agent policy.
    pub fn withdraw(ctx: Context<Withdraw>, amount: u64) -> Result<()> {
        transfer_from_vault(
            &ctx.accounts.vault.to_account_info(),
            &ctx.accounts.destination.to_account_info(),
            amount,
        )?;
        emit!(Withdrawn {
            vault: ctx.accounts.vault.key(),
            destination: ctx.accounts.destination.key(),
            amount,
        });
        Ok(())
    }

    /// Kill switch: freeze or unfreeze every agent session at once.
    pub fn set_frozen(ctx: Context<OwnerOnly>, frozen: bool) -> Result<()> {
        ctx.accounts.vault.frozen = frozen;
        emit!(FrozenSet {
            vault: ctx.accounts.vault.key(),
            frozen,
        });
        Ok(())
    }

    /// Replace the vault policy. Owner only.
    pub fn update_policy(ctx: Context<OwnerOnly>, args: PolicyArgs) -> Result<()> {
        args.validate()?;
        let vault = &mut ctx.accounts.vault;
        // Preserve the running daily spend counter: replacing the policy
        // mid-day must not hand the agent a fresh daily allowance.
        let spent_today = vault.policy.spent_today;
        let last_day = vault.policy.last_day;
        let mut policy = Policy::from_args(&args);
        policy.spent_today = spent_today;
        policy.last_day = last_day;
        vault.policy = policy;
        emit!(PolicyUpdated {
            vault: ctx.accounts.vault.key(),
        });
        Ok(())
    }

    /// Delegate a scoped, expiring session key to an agent.
    pub fn create_session(
        ctx: Context<CreateSession>,
        session_signer: Pubkey,
        expires_at: i64,
        per_tx_limit: u64,
        daily_limit: u64,
    ) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        require!(expires_at > now, MandatError::SessionExpiryInPast);
        require!(
            expires_at
                <= now
                    .checked_add(MAX_SESSION_DURATION)
                    .ok_or(MandatError::Overflow)?,
            MandatError::InvalidSession
        );
        require!(per_tx_limit > 0 && daily_limit > 0, MandatError::ZeroLimit);
        require!(per_tx_limit <= daily_limit, MandatError::InvalidSession);

        let session = &mut ctx.accounts.session;
        session.vault = ctx.accounts.vault.key();
        session.signer = session_signer;
        session.expires_at = expires_at;
        session.per_tx_limit = per_tx_limit;
        session.daily_limit = daily_limit;
        session.spent_today = 0;
        session.last_day = now / SECONDS_PER_DAY;
        session.revoked = false;
        session.bump = ctx.bumps.session;
        // Token path disabled until set_session_token_limits.
        session.token_per_tx_limit = 0;
        session.token_daily_limit = 0;
        session.token_spent_today = 0;
        session.token_last_day = 0;

        emit!(SessionCreated {
            vault: session.vault,
            session: session.key(),
            signer: session_signer,
            expires_at,
        });
        Ok(())
    }

    /// Revoke a session key immediately. Owner only.
    pub fn revoke_session(ctx: Context<RevokeSession>) -> Result<()> {
        ctx.accounts.session.revoked = true;
        emit!(SessionRevoked {
            vault: ctx.accounts.vault.key(),
            session: ctx.accounts.session.key(),
        });
        Ok(())
    }

    /// Close a session account and return its rent to the owner. Owner only;
    /// works whether or not the session was revoked. A new session for the
    /// same signer can be created afterwards.
    pub fn close_session(ctx: Context<CloseSession>) -> Result<()> {
        emit!(SessionClosed {
            vault: ctx.accounts.vault.key(),
            session: ctx.accounts.session.key(),
        });
        Ok(())
    }

    /// The agent path: transfer SOL out of the vault, gated by every policy
    /// check. Signed by the session key, never by the owner.
    pub fn execute_transfer(ctx: Context<ExecuteTransfer>, amount: u64) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let destination = ctx.accounts.destination.key();
        let vault = &mut ctx.accounts.vault;
        let session = &mut ctx.accounts.session;

        let (vault_spend, session_spend) = enforce_policy(
            vault,
            session,
            now,
            &destination,
            amount,
            Limits::sol_vault(&vault.policy),
            Limits::sol_session(session),
        )?;

        // All checks passed: record spend, then move lamports.
        vault.policy.spent_today = vault_spend.spent_today;
        vault.policy.last_day = vault_spend.last_day;
        session.spent_today = session_spend.spent_today;
        session.last_day = session_spend.last_day;

        transfer_from_vault(
            &vault.to_account_info(),
            &ctx.accounts.destination.to_account_info(),
            amount,
        )?;

        emit!(TransferExecuted {
            vault: vault.key(),
            session: session.key(),
            destination,
            amount,
            remaining_daily: vault
                .policy
                .daily_limit
                .saturating_sub(vault.policy.spent_today),
        });
        Ok(())
    }

    /// Owner: allow one SPL mint (e.g. USDC) on the agent token path and set
    /// vault-wide token limits (base units of that mint). Re-configuring the
    /// same mint keeps today's token spend; switching mint resets it, since
    /// the counter is denominated in the old mint.
    pub fn configure_token_policy(
        ctx: Context<ConfigureTokenPolicy>,
        per_tx_limit: u64,
        daily_limit: u64,
    ) -> Result<()> {
        require!(per_tx_limit > 0 && daily_limit > 0, MandatError::ZeroLimit);
        require!(per_tx_limit <= daily_limit, MandatError::InvalidPolicy);
        let mint = ctx.accounts.mint.key();
        let vault = &mut ctx.accounts.vault;
        let tp = &mut vault.token_policy;
        if tp.mint != mint {
            tp.mint = mint;
            tp.spent_today = 0;
            tp.last_day = 0;
        }
        tp.per_tx_limit = per_tx_limit;
        tp.daily_limit = daily_limit;
        emit!(TokenPolicyConfigured {
            vault: vault.key(),
            mint,
            per_tx_limit,
            daily_limit,
        });
        Ok(())
    }

    /// Owner: set a session's token limits (base units of the vault's allowed
    /// mint). 0 / 0 disables the token path for that session (the default).
    /// Today's token spend on the session is kept.
    pub fn set_session_token_limits(
        ctx: Context<SetSessionTokenLimits>,
        per_tx_limit: u64,
        daily_limit: u64,
    ) -> Result<()> {
        require!(per_tx_limit <= daily_limit, MandatError::InvalidSession);
        let session = &mut ctx.accounts.session;
        session.token_per_tx_limit = per_tx_limit;
        session.token_daily_limit = daily_limit;
        emit!(SessionTokenLimitsSet {
            vault: ctx.accounts.vault.key(),
            session: session.key(),
            per_tx_limit,
            daily_limit,
        });
        Ok(())
    }

    /// The agent token path (x402 / USDC): `transfer_checked` from a vault-owned
    /// token account, signed by the vault PDA, gated by the same policy checks
    /// as SOL but with separate token counters. The whitelist is checked
    /// against the destination token account's owner (the wallet), not the ATA.
    pub fn execute_token_transfer(ctx: Context<ExecuteTokenTransfer>, amount: u64) -> Result<()> {
        require!(amount > 0, MandatError::ZeroAmount);
        let now = Clock::get()?.unix_timestamp;
        let destination = ctx.accounts.destination.key();
        let destination_owner = ctx.accounts.destination.owner;
        let vault_key = ctx.accounts.vault.key();
        // Paying the vault itself would only burn the daily budget.
        require!(destination_owner != vault_key, MandatError::DestinationNotAllowed);

        let vault = &mut ctx.accounts.vault;
        let session = &mut ctx.accounts.session;
        require!(
            vault.token_policy.mint != Pubkey::default(),
            MandatError::TokenPolicyNotConfigured
        );

        let (vault_spend, session_spend) = enforce_policy(
            vault,
            session,
            now,
            &destination_owner,
            amount,
            Limits::token_vault(&vault.token_policy),
            Limits::token_session(session),
        )?;
        vault.token_policy.spent_today = vault_spend.spent_today;
        vault.token_policy.last_day = vault_spend.last_day;
        session.token_spent_today = session_spend.spent_today;
        session.token_last_day = session_spend.last_day;
        let remaining_daily = vault
            .token_policy
            .daily_limit
            .saturating_sub(vault.token_policy.spent_today);
        let session_key = session.key();
        let owner_key = ctx.accounts.owner.key();
        let bump = vault.bump;

        let signer_seeds: &[&[&[u8]]] = &[&[b"vault", owner_key.as_ref(), &[bump]]];
        token_interface::transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                TransferChecked {
                    from: ctx.accounts.source.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.destination.to_account_info(),
                    authority: ctx.accounts.vault.to_account_info(),
                },
                signer_seeds,
            ),
            amount,
            ctx.accounts.mint.decimals,
        )?;

        emit!(TokenTransferExecuted {
            vault: vault_key,
            session: session_key,
            mint: ctx.accounts.mint.key(),
            destination_owner,
            destination,
            amount,
            remaining_daily,
        });
        Ok(())
    }

    /// Owner-only token withdrawal from a vault-owned token account (any mint,
    /// so stray tokens can be recovered). Not subject to the agent policy.
    pub fn withdraw_token(ctx: Context<WithdrawToken>, amount: u64) -> Result<()> {
        let owner_key = ctx.accounts.owner.key();
        let bump = ctx.accounts.vault.bump;
        let signer_seeds: &[&[&[u8]]] = &[&[b"vault", owner_key.as_ref(), &[bump]]];
        token_interface::transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                TransferChecked {
                    from: ctx.accounts.source.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.destination.to_account_info(),
                    authority: ctx.accounts.vault.to_account_info(),
                },
                signer_seeds,
            ),
            amount,
            ctx.accounts.mint.decimals,
        )?;
        emit!(TokenWithdrawn {
            vault: ctx.accounts.vault.key(),
            mint: ctx.accounts.mint.key(),
            destination: ctx.accounts.destination.key(),
            amount,
        });
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Shared policy enforcement (SOL and token paths)
// ---------------------------------------------------------------------------

/// A per-tx / daily limit pair plus its running counter, read from either the
/// SOL or the token fields. The two asset classes never share counters.
#[derive(Clone, Copy)]
struct Limits {
    per_tx_limit: u64,
    daily_limit: u64,
    spent_today: u64,
    last_day: i64,
}

impl Limits {
    fn sol_vault(p: &Policy) -> Self {
        Self {
            per_tx_limit: p.per_tx_limit,
            daily_limit: p.daily_limit,
            spent_today: p.spent_today,
            last_day: p.last_day,
        }
    }
    fn sol_session(s: &Session) -> Self {
        Self {
            per_tx_limit: s.per_tx_limit,
            daily_limit: s.daily_limit,
            spent_today: s.spent_today,
            last_day: s.last_day,
        }
    }
    fn token_vault(t: &TokenPolicy) -> Self {
        Self {
            per_tx_limit: t.per_tx_limit,
            daily_limit: t.daily_limit,
            spent_today: t.spent_today,
            last_day: t.last_day,
        }
    }
    fn token_session(s: &Session) -> Self {
        Self {
            per_tx_limit: s.token_per_tx_limit,
            daily_limit: s.token_daily_limit,
            spent_today: s.token_spent_today,
            last_day: s.token_last_day,
        }
    }
}

/// New counter values to write back once every check has passed.
#[derive(Clone, Copy)]
struct Spend {
    spent_today: u64,
    last_day: i64,
}

/// Every agent-path check, in order: kill switch, revoke, expiry, active hours
/// (UTC), destination whitelist (`destination_wallet` is the SOL recipient or
/// the token account's owner), per-tx limits (vault then session), daily
/// limits with `day > last_day` rollover (vault then session).
/// Pure: returns the new counters, the caller commits them.
fn enforce_policy(
    vault: &Vault,
    session: &Session,
    now: i64,
    destination_wallet: &Pubkey,
    amount: u64,
    vault_limits: Limits,
    session_limits: Limits,
) -> Result<(Spend, Spend)> {
    // 1. Kill switch & session validity.
    require!(!vault.frozen, MandatError::VaultFrozen);
    require!(!session.revoked, MandatError::SessionRevoked);
    require!(now < session.expires_at, MandatError::SessionExpired);

    // 2. Active-hours window (UTC). start == end means always active.
    let policy = &vault.policy;
    if policy.active_hour_start != policy.active_hour_end {
        let hour = ((now.rem_euclid(SECONDS_PER_DAY)) / 3600) as u8;
        let inside = if policy.active_hour_start < policy.active_hour_end {
            hour >= policy.active_hour_start && hour < policy.active_hour_end
        } else {
            // Window wraps past midnight, e.g. 22 -> 06.
            hour >= policy.active_hour_start || hour < policy.active_hour_end
        };
        require!(inside, MandatError::OutsideActiveHours);
    }

    // 3. Destination whitelist.
    if policy.restrict_destinations {
        require!(
            policy.allowed_destinations.contains(destination_wallet),
            MandatError::DestinationNotAllowed
        );
    }

    // 4. Per-transaction limits (vault-wide and session-specific).
    require!(
        amount <= vault_limits.per_tx_limit,
        MandatError::PerTxLimitExceeded
    );
    require!(
        amount <= session_limits.per_tx_limit,
        MandatError::PerTxLimitExceeded
    );

    // 5. Daily limits with day rollover.
    let day = now / SECONDS_PER_DAY;
    let vault_spend = next_spend(&vault_limits, day, amount)?;
    let session_spend = next_spend(&session_limits, day, amount)?;
    Ok((vault_spend, session_spend))
}

/// Apply rollover (`>` not `!=`: a clock that moves backwards must not reset
/// the counter), add `amount`, and check it against the daily limit.
fn next_spend(l: &Limits, day: i64, amount: u64) -> Result<Spend> {
    let (base, last_day) = if day > l.last_day {
        (0, day)
    } else {
        (l.spent_today, l.last_day)
    };
    let spent_today = base.checked_add(amount).ok_or(MandatError::Overflow)?;
    require!(spent_today <= l.daily_limit, MandatError::DailyLimitExceeded);
    Ok(Spend {
        spent_today,
        last_day,
    })
}

/// Move lamports out of the vault PDA while keeping it rent-exempt.
fn transfer_from_vault<'info>(
    vault: &AccountInfo<'info>,
    destination: &AccountInfo<'info>,
    amount: u64,
) -> Result<()> {
    let rent_minimum = Rent::get()?.minimum_balance(vault.data_len());
    let available = vault
        .lamports()
        .checked_sub(rent_minimum)
        .ok_or(MandatError::InsufficientFunds)?;
    require!(amount <= available, MandatError::InsufficientFunds);

    **vault.try_borrow_mut_lamports()? -= amount;
    **destination.try_borrow_mut_lamports()? += amount;
    Ok(())
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

#[account]
#[derive(InitSpace)]
pub struct Vault {
    pub owner: Pubkey,
    pub bump: u8,
    pub frozen: bool,
    pub policy: Policy,
    /// SPL token path (x402 / USDC). Separate counters from the SOL policy.
    pub token_policy: TokenPolicy,
}

/// Vault-wide limits for the single allowed SPL mint, in that mint's base
/// units. `mint == Pubkey::default()` means the token path is disabled.
/// Active hours, the destination whitelist and the kill switch are shared
/// with the SOL path (`Vault::policy`, `Vault::frozen`).
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Default, InitSpace)]
pub struct TokenPolicy {
    pub mint: Pubkey,
    pub per_tx_limit: u64,
    pub daily_limit: u64,
    pub spent_today: u64,
    pub last_day: i64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, InitSpace)]
pub struct Policy {
    pub per_tx_limit: u64,
    pub daily_limit: u64,
    pub spent_today: u64,
    pub last_day: i64,
    /// 0-23 UTC. start == end disables the window check.
    pub active_hour_start: u8,
    pub active_hour_end: u8,
    pub restrict_destinations: bool,
    #[max_len(MAX_ALLOWED_DESTINATIONS)]
    pub allowed_destinations: Vec<Pubkey>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct PolicyArgs {
    pub per_tx_limit: u64,
    pub daily_limit: u64,
    pub active_hour_start: u8,
    pub active_hour_end: u8,
    pub restrict_destinations: bool,
    pub allowed_destinations: Vec<Pubkey>,
}

impl PolicyArgs {
    fn validate(&self) -> Result<()> {
        require!(
            self.per_tx_limit > 0 && self.daily_limit > 0,
            MandatError::ZeroLimit
        );
        require!(
            self.per_tx_limit <= self.daily_limit,
            MandatError::InvalidPolicy
        );
        require!(
            self.active_hour_start < 24 && self.active_hour_end < 24,
            MandatError::InvalidPolicy
        );
        require!(
            self.allowed_destinations.len() <= MAX_ALLOWED_DESTINATIONS,
            MandatError::InvalidPolicy
        );
        require!(
            !self.restrict_destinations || !self.allowed_destinations.is_empty(),
            MandatError::InvalidPolicy
        );
        Ok(())
    }
}

impl Policy {
    fn from_args(args: &PolicyArgs) -> Self {
        Self {
            per_tx_limit: args.per_tx_limit,
            daily_limit: args.daily_limit,
            spent_today: 0,
            last_day: 0,
            active_hour_start: args.active_hour_start,
            active_hour_end: args.active_hour_end,
            restrict_destinations: args.restrict_destinations,
            allowed_destinations: args.allowed_destinations.clone(),
        }
    }
}

#[account]
#[derive(InitSpace)]
pub struct Session {
    pub vault: Pubkey,
    /// Ephemeral keypair the agent signs with.
    pub signer: Pubkey,
    pub expires_at: i64,
    pub per_tx_limit: u64,
    pub daily_limit: u64,
    pub spent_today: u64,
    pub last_day: i64,
    pub revoked: bool,
    pub bump: u8,
    /// Token-path limits (base units of `vault.token_policy.mint`); 0 = disabled.
    pub token_per_tx_limit: u64,
    pub token_daily_limit: u64,
    pub token_spent_today: u64,
    pub token_last_day: i64,
}

// ---------------------------------------------------------------------------
// Contexts
// ---------------------------------------------------------------------------

#[derive(Accounts)]
pub struct InitializeVault<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(
        init,
        payer = owner,
        space = 8 + Vault::INIT_SPACE,
        seeds = [b"vault", owner.key().as_ref()],
        bump
    )]
    pub vault: Account<'info, Vault>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Deposit<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(
        mut,
        seeds = [b"vault", owner.key().as_ref()],
        bump = vault.bump,
        has_one = owner @ MandatError::Unauthorized
    )]
    pub vault: Account<'info, Vault>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Withdraw<'info> {
    pub owner: Signer<'info>,
    #[account(
        mut,
        seeds = [b"vault", owner.key().as_ref()],
        bump = vault.bump,
        has_one = owner @ MandatError::Unauthorized
    )]
    pub vault: Account<'info, Vault>,
    /// CHECK: destination chosen by the owner; lamports only.
    #[account(mut)]
    pub destination: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct OwnerOnly<'info> {
    pub owner: Signer<'info>,
    #[account(
        mut,
        seeds = [b"vault", owner.key().as_ref()],
        bump = vault.bump,
        has_one = owner @ MandatError::Unauthorized
    )]
    pub vault: Account<'info, Vault>,
}

#[derive(Accounts)]
#[instruction(session_signer: Pubkey)]
pub struct CreateSession<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(
        seeds = [b"vault", owner.key().as_ref()],
        bump = vault.bump,
        has_one = owner @ MandatError::Unauthorized
    )]
    pub vault: Account<'info, Vault>,
    #[account(
        init,
        payer = owner,
        space = 8 + Session::INIT_SPACE,
        seeds = [b"session", vault.key().as_ref(), session_signer.as_ref()],
        bump
    )]
    pub session: Account<'info, Session>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RevokeSession<'info> {
    pub owner: Signer<'info>,
    #[account(
        seeds = [b"vault", owner.key().as_ref()],
        bump = vault.bump,
        has_one = owner @ MandatError::Unauthorized
    )]
    pub vault: Account<'info, Vault>,
    #[account(
        mut,
        seeds = [b"session", vault.key().as_ref(), session.signer.as_ref()],
        bump = session.bump
    )]
    pub session: Account<'info, Session>,
}

#[derive(Accounts)]
pub struct CloseSession<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(
        seeds = [b"vault", owner.key().as_ref()],
        bump = vault.bump,
        has_one = owner @ MandatError::Unauthorized
    )]
    pub vault: Account<'info, Vault>,
    #[account(
        mut,
        seeds = [b"session", vault.key().as_ref(), session.signer.as_ref()],
        bump = session.bump,
        has_one = vault @ MandatError::Unauthorized,
        close = owner
    )]
    pub session: Account<'info, Session>,
}

#[derive(Accounts)]
pub struct ExecuteTransfer<'info> {
    /// The ephemeral agent key. Must match the registered session signer.
    pub session_signer: Signer<'info>,
    /// CHECK: vault owner pubkey used only for PDA derivation.
    pub owner: UncheckedAccount<'info>,
    #[account(
        mut,
        seeds = [b"vault", owner.key().as_ref()],
        bump = vault.bump,
        has_one = owner @ MandatError::Unauthorized
    )]
    pub vault: Account<'info, Vault>,
    #[account(
        mut,
        seeds = [b"session", vault.key().as_ref(), session_signer.key().as_ref()],
        bump = session.bump,
        constraint = session.signer == session_signer.key() @ MandatError::Unauthorized,
        constraint = session.vault == vault.key() @ MandatError::Unauthorized
    )]
    pub session: Account<'info, Session>,
    /// CHECK: validated against the policy whitelist when enabled.
    #[account(mut)]
    pub destination: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct ConfigureTokenPolicy<'info> {
    pub owner: Signer<'info>,
    #[account(
        mut,
        seeds = [b"vault", owner.key().as_ref()],
        bump = vault.bump,
        has_one = owner @ MandatError::Unauthorized
    )]
    pub vault: Account<'info, Vault>,
    /// Must be a real mint owned by SPL Token or Token-2022.
    pub mint: InterfaceAccount<'info, Mint>,
}

#[derive(Accounts)]
pub struct SetSessionTokenLimits<'info> {
    pub owner: Signer<'info>,
    #[account(
        seeds = [b"vault", owner.key().as_ref()],
        bump = vault.bump,
        has_one = owner @ MandatError::Unauthorized
    )]
    pub vault: Account<'info, Vault>,
    #[account(
        mut,
        seeds = [b"session", vault.key().as_ref(), session.signer.as_ref()],
        bump = session.bump,
        has_one = vault @ MandatError::Unauthorized
    )]
    pub session: Account<'info, Session>,
}

#[derive(Accounts)]
pub struct ExecuteTokenTransfer<'info> {
    /// The ephemeral agent key. Only signer this instruction needs, so an
    /// x402 sponsor/fee payer never has to appear in the accounts.
    pub session_signer: Signer<'info>,
    /// CHECK: vault owner pubkey used only for PDA derivation.
    pub owner: UncheckedAccount<'info>,
    #[account(
        mut,
        seeds = [b"vault", owner.key().as_ref()],
        bump = vault.bump,
        has_one = owner @ MandatError::Unauthorized
    )]
    pub vault: Account<'info, Vault>,
    #[account(
        mut,
        seeds = [b"session", vault.key().as_ref(), session_signer.key().as_ref()],
        bump = session.bump,
        constraint = session.signer == session_signer.key() @ MandatError::Unauthorized,
        has_one = vault @ MandatError::Unauthorized
    )]
    pub session: Account<'info, Session>,
    #[account(
        constraint = mint.key() == vault.token_policy.mint @ MandatError::MintNotAllowed,
        mint::token_program = token_program
    )]
    pub mint: InterfaceAccount<'info, Mint>,
    /// Vault-owned token account (normally the vault PDA's ATA).
    #[account(
        mut,
        token::mint = mint,
        token::authority = vault,
        token::token_program = token_program
    )]
    pub source: InterfaceAccount<'info, TokenAccount>,
    /// Recipient token account; its `owner` is what the whitelist checks.
    #[account(
        mut,
        token::mint = mint,
        token::token_program = token_program,
        constraint = destination.key() != source.key() @ MandatError::DestinationNotAllowed
    )]
    pub destination: InterfaceAccount<'info, TokenAccount>,
    /// SPL Token or Token-2022 only (program ID checked by Anchor).
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct WithdrawToken<'info> {
    pub owner: Signer<'info>,
    #[account(
        seeds = [b"vault", owner.key().as_ref()],
        bump = vault.bump,
        has_one = owner @ MandatError::Unauthorized
    )]
    pub vault: Account<'info, Vault>,
    #[account(mint::token_program = token_program)]
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(
        mut,
        token::mint = mint,
        token::authority = vault,
        token::token_program = token_program
    )]
    pub source: InterfaceAccount<'info, TokenAccount>,
    #[account(
        mut,
        token::mint = mint,
        token::token_program = token_program
    )]
    pub destination: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
}

// ---------------------------------------------------------------------------
// Events & errors
// ---------------------------------------------------------------------------

#[event]
pub struct VaultInitialized {
    pub vault: Pubkey,
    pub owner: Pubkey,
}

#[event]
pub struct Deposited {
    pub vault: Pubkey,
    pub amount: u64,
}

#[event]
pub struct Withdrawn {
    pub vault: Pubkey,
    pub destination: Pubkey,
    pub amount: u64,
}

#[event]
pub struct FrozenSet {
    pub vault: Pubkey,
    pub frozen: bool,
}

#[event]
pub struct PolicyUpdated {
    pub vault: Pubkey,
}

#[event]
pub struct SessionCreated {
    pub vault: Pubkey,
    pub session: Pubkey,
    pub signer: Pubkey,
    pub expires_at: i64,
}

#[event]
pub struct SessionRevoked {
    pub vault: Pubkey,
    pub session: Pubkey,
}

#[event]
pub struct SessionClosed {
    pub vault: Pubkey,
    pub session: Pubkey,
}

#[event]
pub struct TransferExecuted {
    pub vault: Pubkey,
    pub session: Pubkey,
    pub destination: Pubkey,
    pub amount: u64,
    pub remaining_daily: u64,
}

#[event]
pub struct TokenPolicyConfigured {
    pub vault: Pubkey,
    pub mint: Pubkey,
    pub per_tx_limit: u64,
    pub daily_limit: u64,
}

#[event]
pub struct SessionTokenLimitsSet {
    pub vault: Pubkey,
    pub session: Pubkey,
    pub per_tx_limit: u64,
    pub daily_limit: u64,
}

#[event]
pub struct TokenTransferExecuted {
    pub vault: Pubkey,
    pub session: Pubkey,
    pub mint: Pubkey,
    pub destination_owner: Pubkey,
    pub destination: Pubkey,
    pub amount: u64,
    pub remaining_daily: u64,
}

#[event]
pub struct TokenWithdrawn {
    pub vault: Pubkey,
    pub mint: Pubkey,
    pub destination: Pubkey,
    pub amount: u64,
}

#[error_code]
pub enum MandatError {
    #[msg("Vault is frozen by its owner")]
    VaultFrozen,
    #[msg("Session has been revoked")]
    SessionRevoked,
    #[msg("Session has expired")]
    SessionExpired,
    #[msg("Session expiry must be in the future")]
    SessionExpiryInPast,
    #[msg("Outside the policy's active hours")]
    OutsideActiveHours,
    #[msg("Destination is not on the policy whitelist")]
    DestinationNotAllowed,
    #[msg("Amount exceeds the per-transaction limit")]
    PerTxLimitExceeded,
    #[msg("Amount exceeds the daily limit")]
    DailyLimitExceeded,
    #[msg("Insufficient vault funds")]
    InsufficientFunds,
    #[msg("Limits must be greater than zero")]
    ZeroLimit,
    #[msg("Invalid policy parameters")]
    InvalidPolicy,
    #[msg("Unauthorized")]
    Unauthorized,
    #[msg("Arithmetic overflow")]
    Overflow,
    #[msg("Invalid session parameters")]
    InvalidSession,
    #[msg("Mint is not the vault's allowed token mint")]
    MintNotAllowed,
    #[msg("Token path is not configured for this vault")]
    TokenPolicyNotConfigured,
    #[msg("Amount must be greater than zero")]
    ZeroAmount,
}
