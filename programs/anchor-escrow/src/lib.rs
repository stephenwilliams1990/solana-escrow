use anchor_lang::prelude::*;
use anchor_spl::token::{self, SetAuthority, TokenAccount, Transfer, CloseAccount, Mint};
use spl_token::instruction::AuthorityType;

declare_id!("AATdQpopjKABYHXMthLY7HCjpFHeDLUw6cgAK2rwD7vY");

#[program]
pub mod anchor_escrow {
    use super::*;
    
    const ESCROW_PDA_SEED: &[u8] = b"authority-seed";
    
    pub fn initialize_escrow(
        ctx: Context<InitializeEscrow>,
        _vault_account_bump: u8,
        initializer_amount: u64,
        taker_amount: u64,
    ) -> ProgramResult {
        // create the escrow_account by defining its parameters
        
        ctx.accounts.escrow_account.initializer_key = *ctx.accounts.initializer.key; // suggest that the .key attribute is a pointer reference, that we need to dereference in order to access the stored value in memory
        ctx.accounts
            .escrow_account
            .initializer_deposit_token_account = *ctx
            .accounts
            .initializer_deposit_token_account
            .to_account_info()  // when we are referencing an account we need to use this to_account_info() call
            .key;
        ctx.accounts
            .escrow_account
            .initializer_receive_token_account = *ctx
            .accounts
            .initializer_receive_token_account
            .to_account_info()
            .key;
        ctx.accounts.escrow_account.initializer_amount = initializer_amount;
        ctx.accounts.escrow_account.taker_amount = taker_amount;

        let (vault_authority, _vault_authority_bump) = Pubkey::find_program_address(&[ESCROW_PDA_SEED], ctx.program_id); // program_id is a standard attribute we can call straight from the context
        // set the authority of the token program to the pda account generated
        token::set_authority(
            ctx.accounts.into_set_authority_context(), // this is the ctx variable, which takes CpiContext<'a, 'b, 'c, 'info, SetAuthority<'info>>
            AuthorityType::AccountOwner, // authority type variable
            Some(vault_authority) // the new authority - which takes an option variable --> Option<T> which has a value of None, Some(T) 
        )?; 

        token::transfer(
            ctx.accounts.into_transfer_to_pda_context(), // ctx variable which we define below
            ctx.accounts.escrow_account.initializer_amount, // amount: u64
        )?;

        Ok(())
    }

    pub fn cancel_escrow(ctx: Context<CancelEscrow>) -> ProgramResult{
        let(_vault_authority, vault_authority_bump) = Pubkey::find_program_address(&[ESCROW_PDA_SEED], ctx.program_id);
        let authority_seeds = &[&ESCROW_PDA_SEED[..], &[vault_authority_bump]]; // this is what is in the docs for processing an invoke_signed transaction on a cpi 
        
        // transfer tokens back from the vault account to the initializers token account
        token::transfer(
            ctx.accounts
                .into_transfer_to_initializer_context()
                .with_signer(&[&authority_seeds[..]]),
            ctx.accounts.escrow_account.initializer_amount,
        )?;

        token::close_account(
            ctx.accounts
                .into_close_context()
                .with_signer(&[&authority_seeds[..]]),
        )?;

        Ok(())
    }

    pub fn exchange(ctx: Context<Exchange>) -> ProgramResult {  // doesn't pass through the expected amount as in paulx tutorial
        // Transferring from initializer to taker
        let (_vault_authority, vault_authority_bump) = Pubkey::find_program_address(&[ESCROW_PDA_SEED], ctx.program_id);
        let authority_seeds = &[&ESCROW_PDA_SEED[..], &[vault_authority_bump]];

        // transfer from taker to initializer - no need to sign as it is run by the takers account so they sign implicitly
        token::transfer(
            ctx.accounts.into_transfer_to_initializer_context(),
            ctx.accounts.escrow_account.taker_amount,
        )?;

        token::transfer(
            ctx.accounts
                .into_transfer_to_taker_context()
                .with_signer(&[&authority_seeds[..]]),
            ctx.accounts.escrow_account.initializer_amount,
        )?;

        // this example simply closes the account after finishing the exchange instead of merely returning authority of the pda account to the initializer
        token::close_account(
            ctx.accounts
                .into_close_context()
                .with_signer(&[&authority_seeds[..]]),
        )?;

        Ok(())
    }
}

#[derive(Accounts)]
#[instruction(vault_account_bump: u8, initializer_amount: u64)] // we include this here to be able to reference it below for the constraint of the initializer_deposit_token_account amount
pub struct InitializeEscrow<'info> {
    #[account(mut, signer)] // checks the given account signs the transaction -- is mut necessary?
    pub initializer: AccountInfo<'info>, // standard account from the anchor_lang::prelude library
    pub mint: Account<'info, Mint>, 
    #[account(
        init, 
        seeds = [b"token-seed".as_ref()], 
        bump = vault_account_bump,
        payer = initializer,
        token::mint = mint,
        token::authority = initializer,
)]
    pub vault_account: Account<'info, TokenAccount>,
    #[account(
        mut,
        constraint = initializer_deposit_token_account.amount >= initializer_amount  // chuck in the constraint that we want here
    )]
    pub initializer_deposit_token_account: Account<'info, TokenAccount>, // this is a standard TokenAccount struct from the anchor_spl::token module
    pub initializer_receive_token_account: Account<'info, TokenAccount>,
    // #[account(init, payer = initializer, space = 8 + EscrowAccount::LEN)] // see below where we calculate the LEN of the customised EscrowAccount struct --> standard way to define how much space we need to allocate to an account
    #[account(zero)] // not sure why this replaces the above line
    pub escrow_account: ProgramAccount<'info, EscrowAccount>, 
    // pub system_program: Program<'info, System>, // this and the below token_program account are standard variables
    pub system_program: AccountInfo<'info>, // should this not reference the system program?
    pub rent: Sysvar<'info, Rent>,
    // pub token_program: Program<'info, Token>, 
    pub token_program: AccountInfo<'info>, // again, shouldn't this reference the Token program?
}

#[derive(Accounts)]
pub struct CancelEscrow<'info> {
    #[account(mut, signer)]
    pub initializer: AccountInfo<'info>,
    #[account(mut)]
    pub vault_account: Account<'info, TokenAccount>,
    pub vault_authority: AccountInfo<'info>,
    #[account(mut)]
    pub initializer_deposit_token_account: Account<'info, TokenAccount>,
    #[account(
        mut,
        constraint = escrow_account.initializer_key == *initializer.key, // make sure the initializer of this cancel call is the same account that initialised the original escrow account
        constraint = escrow_account.initializer_deposit_token_account == *initializer_deposit_token_account.to_account_info().key, // another check to make sure that the account that will receive the tokens is the same as in the escrow account metadata
        close = initializer, // Marks the account as being closed at the end of the instruction’s execution, sending the rent exemption lamports to the specified account.
    )]
    pub escrow_account: ProgramAccount<'info, EscrowAccount>, // needs to be program account to call a close instruction as above
    pub token_program: AccountInfo<'info>, // again should this not be a token program call?
}

#[derive(Accounts)]
pub struct Exchange<'info> {
    #[account(signer)]
    pub taker: AccountInfo<'info>,
    #[account(mut)]
    pub taker_deposit_token_account: Account<'info, TokenAccount>,
    #[account(mut)]
    pub taker_receive_token_account: Account<'info, TokenAccount>,
    #[account(mut)]
    pub initializer_deposit_token_account: Account<'info, TokenAccount>,
    #[account(mut)]
    pub initializer_receive_token_account: Account<'info, TokenAccount>,
    #[account(mut)] // to receive rent?
    pub initializer: AccountInfo<'info>,
    #[account(
        mut,
        constraint = escrow_account.taker_amount <= taker_deposit_token_account.amount,
        constraint = escrow_account.initializer_deposit_token_account == *initializer_deposit_token_account.to_account_info().key, // these constraints make sure that the taker is sending and receiving from the correct accounts
        constraint = escrow_account.initializer_receive_token_account == *initializer_receive_token_account.to_account_info().key,
        constraint = escrow_account.initializer_key == *initializer.key,
        close = initializer
    )]
    pub escrow_account: ProgramAccount<'info, EscrowAccount>,
    #[account(mut)]
    pub vault_account: Account<'info, TokenAccount>,
    pub vault_authority: AccountInfo<'info>,
    pub token_program: AccountInfo<'info>, // token_program alright here? Same q as above
}

#[account]
pub struct EscrowAccount {  // defining the EscrowAccount struct
    pub initializer_key: Pubkey,
    pub initializer_deposit_token_account: Pubkey,
    pub initializer_receive_token_account: Pubkey,
    pub initializer_amount: u64,
    pub taker_amount: u64,
}

impl<'info> InitializeEscrow<'info> {
    fn into_set_authority_context(&self) -> CpiContext<'_, '_, '_, 'info, SetAuthority<'info>> {
        let cpi_accounts = SetAuthority {
            current_authority: self.initializer.clone(), 
            account_or_mint: self.vault_account.to_account_info().clone(), // account to which we are assigning authority
        };
        CpiContext::new(self.token_program.clone(), cpi_accounts) // docs are as so: pub fn new(program: AccountInfo<'info>, accounts: T) -> Self
    }

    fn into_transfer_to_pda_context(&self) -> CpiContext<'_, '_, '_, 'info, Transfer<'info>> {
        let cpi_accounts = Transfer {
            from: self.initializer_deposit_token_account.to_account_info().clone(), // to_account_info() needed if it is a CpiAccount?
            to: self.vault_account.to_account_info().clone(),
            authority: self.initializer.clone(), 
        };
        CpiContext::new(self.token_program.clone(), cpi_accounts)
    }
}

impl<'info> CancelEscrow<'info> {
    fn into_transfer_to_initializer_context(&self) -> CpiContext<'_, '_, '_, 'info, Transfer<'info>> {
        let cpi_accounts = Transfer {
            from: self.vault_account.to_account_info().clone(),
            to: self.initializer_deposit_token_account.to_account_info().clone(),
            authority: self.vault_authority.clone(), 
        };
        CpiContext::new(self.token_program.clone(), cpi_accounts)
    }

    fn into_close_context(&self) -> CpiContext<'_, '_, '_, 'info, CloseAccount<'info>> {
        let cpi_accounts = CloseAccount {
            account: self.vault_account.to_account_info().clone(),
            destination: self.initializer.clone(),
            authority: self.vault_authority.clone(),
        };
        CpiContext::new(self.token_program.clone(), cpi_accounts)
    }
}

impl<'info> Exchange<'info> {
    fn into_transfer_to_initializer_context(&self) -> CpiContext<'_, '_, '_, 'info, Transfer<'info>> {
        let cpi_accounts = Transfer {
            from: self.taker_deposit_token_account.to_account_info().clone(),
            to: self.initializer_receive_token_account.to_account_info().clone(),
            authority: self.taker.clone(),
        };
        CpiContext::new(self.token_program.clone(), cpi_accounts)
    }
    
    fn into_transfer_to_taker_context(&self) -> CpiContext<'_, '_, '_, 'info, Transfer<'info>> {
        let cpi_accounts = Transfer {
            from: self.vault_account.to_account_info().clone(),
            to: self.taker_receive_token_account.to_account_info().clone(),
            authority: self.vault_authority.clone(),
        };
        CpiContext::new(self.token_program.clone(), cpi_accounts)
    }
        
    fn into_close_context(&self) -> CpiContext<'_, '_, '_, 'info, CloseAccount<'info>> {
        let cpi_accounts = CloseAccount {
            account: self.vault_account.to_account_info().clone(),
            destination: self.initializer.clone(),
            authority: self.vault_authority.clone(),
        };
        CpiContext::new(self.token_program.clone(), cpi_accounts)
    }
        
}