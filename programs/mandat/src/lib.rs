use anchor_lang::prelude::*;

declare_id!("2nJTE7vKVaV3pum9jV9NTYP3MPMqAx2GojqxFQn9W2kz");

pub const SECONDS_PER_DAY: i64 = 86_400;
pub const MAX_ALLOWED_DESTINATIONS: usize = 16;

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
        ctx.accounts.vault.policy = Policy::from_args(&args);
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
        require!(per_tx_limit > 0 && daily_limit > 0, MandatError::ZeroLimit);

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

    /// The agent path: transfer SOL out of the vault, gated by every policy
    /// check. Signed by the session key, never by the owner.
    pub fn execute_transfer(ctx: Context<ExecuteTransfer>, amount: u64) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let vault = &mut ctx.accounts.vault;
        let session = &mut ctx.accounts.session;

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
                policy
                    .allowed_destinations
                    .contains(&ctx.accounts.destination.key()),
                MandatError::DestinationNotAllowed
            );
        }

        // 4. Per-transaction limits (vault-wide and session-specific).
        require!(amount <= policy.per_tx_limit, MandatError::PerTxLimitExceeded);
        require!(amount <= session.per_tx_limit, MandatError::PerTxLimitExceeded);

        // 5. Daily limits with day rollover.
        let day = now / SECONDS_PER_DAY;
        if day != vault.policy.last_day {
            vault.policy.last_day = day;
            vault.policy.spent_today = 0;
        }
        if day != session.last_day {
            session.last_day = day;
            session.spent_today = 0;
        }
        let vault_spent = vault
            .policy
            .spent_today
            .checked_add(amount)
            .ok_or(MandatError::Overflow)?;
        require!(
            vault_spent <= vault.policy.daily_limit,
            MandatError::DailyLimitExceeded
        );
        let session_spent = session
            .spent_today
            .checked_add(amount)
            .ok_or(MandatError::Overflow)?;
        require!(
            session_spent <= session.daily_limit,
            MandatError::DailyLimitExceeded
        );

        // All checks passed: record spend, then move lamports.
        vault.policy.spent_today = vault_spent;
        session.spent_today = session_spent;

        transfer_from_vault(
            &vault.to_account_info(),
            &ctx.accounts.destination.to_account_info(),
            amount,
        )?;

        emit!(TransferExecuted {
            vault: vault.key(),
            session: session.key(),
            destination: ctx.accounts.destination.key(),
            amount,
            remaining_daily: vault.policy.daily_limit - vault.policy.spent_today,
        });
        Ok(())
    }
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
pub struct TransferExecuted {
    pub vault: Pubkey,
    pub session: Pubkey,
    pub destination: Pubkey,
    pub amount: u64,
    pub remaining_daily: u64,
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
}
