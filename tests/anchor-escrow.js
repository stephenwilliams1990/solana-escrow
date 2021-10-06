const assert = require("assert");
const anchor = require('@project-serum/anchor');
const { PublicKey, Transaction, SystemProgram } = anchor.web3;
const { TOKEN_PROGRAM_ID, Token } = require("@solana/spl-token");

describe('anchor-escrow', () => {

  // Configure the client to use the local cluster.
  const provider = anchor.Provider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.AnchorEscrow;

  // define all accounts that we will use later - these are the accounts that we can create from the accounts we define below by generating keypairs
  let mintA = null; // created later using the defined mintAuthority pubkey below
  let mintB = null;
  let initializerTokenAccountA = null; // created after we create the mintA and using the initializers main account as authority
  let initializerTokenAccountB = null;
  let takerTokenAccountA = null; // created after we create the mintA and using the takers main account as authority
  let takerTokenAccountB = null;
  let vault_account_pda = null; // created by the findProgramAddress function from the PublicKey module inserting a buffered seed phrase and using the programId 
  let vault_account_bump = null;
  let vault_authority_pda = null;

  const takerAmount = 1000;
  const initializerAmount = 500;

  // these are the accounts that we can use to generate the null accounts above
  const escrowAccount = anchor.web3.Keypair.generate();
  const payer = anchor.web3.Keypair.generate();
  const mintAuthority = anchor.web3.Keypair.generate();
  const initializerMainAccount = anchor.web3.Keypair.generate();
  const takerMainAccount = anchor.web3.Keypair.generate();

  it('It initializes escrow state!', async () => {
    
    // Airdropping tokens to a payer
    await provider.connection.confirmTransaction(
      await provider.connection.requestAirdrop(payer.publicKey, 10000000000),
      "confirmed"
    );

    // Fund main accounts
    await provider.send(
      (() => { // what does this mean in general ?? () => { some code }
        const tx = new Transaction();
        tx.add(
          SystemProgram.transfer({
            fromPubkey: payer.publicKey,
            toPubkey: initializerMainAccount.publicKey,
            lamports: 1000000000,
          }),
          SystemProgram.transfer({
            fromPubkey: payer.publicKey,
            toPubkey: takerMainAccount.publicKey,
            lamports: 1000000000,
          })
        );
        return tx;
      })(), // what happens if we remve these brackets??
      [payer] // signers
    );
    
    mintA = await Token.createMint(
      provider.connection, // connection to use
      payer, // payer fee payer for transaction
      mintAuthority.publicKey, // mintAuthority Account or multisig that will control minting
      null, // freeze authority (optional)
      0, // decimals Location of the decimal place
      TOKEN_PROGRAM_ID // programId optional token programId --> uses the system programId by default
    );

    mintB = await Token.createMint(
      provider.connection, // connection to use
      payer, // payer fee payer for transaction
      mintAuthority.publicKey, // mintAuthority Account or multisig that will control minting
      null, // freeze authority (optional)
      0, // decimals Location of the decimal place
      TOKEN_PROGRAM_ID // programId optional token programId --> uses the system programId by default
    );

    initializerTokenAccountA = await mintA.createAccount(initializerMainAccount.publicKey); // create an A token account for the initializer, setting their main account as the authority
    takerTokenAccountA = await mintA.createAccount(takerMainAccount.publicKey);

    initializerTokenAccountB = await mintB.createAccount(initializerMainAccount.publicKey);
    takerTokenAccountB = await mintB.createAccount(takerMainAccount.publicKey);

    // this takes the token A mint and mints some - what I don't get is who pays for this? Is it like an airdrop?
    await mintA.mintTo(
      initializerTokenAccountA, // address of the account to send the minted tokens to
      mintAuthority.publicKey, // public key of the person who has the minting authority over the token
      [mintAuthority], // signers address
      initializerAmount // amount
    );

    await mintB.mintTo(
      takerTokenAccountB,
      mintAuthority.publicKey,
      [mintAuthority],
      takerAmount
    );

    let _initializerTokenAccountA = await mintA.getAccountInfo(initializerTokenAccountA);
    let _takerTokenAccountB = await mintB.getAccountInfo(takerTokenAccountB);

    assert.ok(_initializerTokenAccountA.amount.toNumber() == initializerAmount);
    assert.ok(_takerTokenAccountB.amount.toNumber() == takerAmount);

    let _initializerStartingBal = await provider.connection.getBalance(initializerMainAccount.publicKey);
    let _takerStartingBal = await provider.connection.getBalance(takerMainAccount.publicKey);

    console.log("Initializer starting balance: ", _initializerStartingBal);
    console.log("Taker starting balance: ", _takerStartingBal);

  });

  it("Initialises escrow", async () => {
    // Generate the pdas, as we need the vault_account_bump in order to pass through as a parameter to the initializeEscrow function
    const [_vault_account_pda, _vault_account_bump] = await PublicKey.findProgramAddress(
      [Buffer.from(anchor.utils.bytes.utf8.encode("token-seed"))], // notice the difference in how we feed in a buffered seed phrase to the findProgramAddress function
      program.programId
    );

    vault_account_pda = _vault_account_pda; 
    vault_account_bump = _vault_account_bump;
    
    // the seed used below must match the seed used in the ESCROW_PDA_SEED variable in lib.rs
    const [_vault_authority_pda, _vault_authority_bump] = await PublicKey.findProgramAddress(
      [Buffer.from(anchor.utils.bytes.utf8.encode("authority-seed"))], // notice the difference in how we feed in a buffered seed phrase to the findProgramAddress function
      program.programId
    );
    
    vault_authority_pda = _vault_authority_pda;

    await program.rpc.initializeEscrow(
      vault_account_bump,
      new anchor.BN(initializerAmount),
      new anchor.BN(takerAmount),
      {
        accounts: {
          initializer: initializerMainAccount.publicKey,
          mint: mintA.publicKey, // why mint A
          vaultAccount: vault_account_pda, // a pda is a public key that doesn't have a private key, so this is already a publicKey
          initializerDepositTokenAccount: initializerTokenAccountA, // a minted account is a public key seemingly
          initializerReceiveTokenAccount: initializerTokenAccountB,
          escrowAccount: escrowAccount.publicKey,
          systemProgram: anchor.web3.SystemProgram.programId, // just need to remember how to pass in the system program
          rent: anchor.web3.SYSVAR_RENT_PUBKEY, // just need to remember how to pass in the rent 
          tokenProgram: TOKEN_PROGRAM_ID // the token program defines a common implementation for fungible and non-fungible tokens
        },
        instructions: [
          await program.account.escrowAccount.createInstruction(escrowAccount), // don't get this instruction
        ],
        signers: [escrowAccount, initializerMainAccount], // don't get why the escrowAccount is included here? Maybe should be vaultAccount?
      }
    );

    let _vault = await mintA.getAccountInfo(vault_account_pda); // after the initializeEscrow macro the vault_account_pda should now have authority over initializerTokenAccountA
    let _escrowAccount = await program.account.escrowAccount.fetch(escrowAccount.publicKey);

    // check that the new owner is the pda
    assert.ok(_vault.owner.equals(vault_authority_pda));

    // Check that the values in the escrow account match what we expect
    assert.ok(_escrowAccount.initializerKey.equals(initializerMainAccount.publicKey));
    assert.ok(_escrowAccount.initializerDepositTokenAccount.equals(initializerTokenAccountA));
    assert.ok(_escrowAccount.initializerReceiveTokenAccount.equals(initializerTokenAccountB));
    assert.ok(_escrowAccount.initializerAmount.toNumber() == initializerAmount); // notice the different syntax for pubkeys and numbers
    assert.ok(_escrowAccount.takerAmount.toNumber() == takerAmount);
    assert.ok(_vault.amount.toNumber() == initializerAmount); // extra one to see if the transfer was made to the vault account
  });

  it("Processes the exchange", async () => {
    await program.rpc.exchange({
      accounts: {
        taker: takerMainAccount.publicKey,
        takerDepositTokenAccount: takerTokenAccountB,
        takerReceiveTokenAccount: takerTokenAccountA,
        initializerDepositTokenAccount: initializerTokenAccountA,
        initializerReceiveTokenAccount: initializerTokenAccountB,
        initializer: initializerMainAccount.publicKey,
        escrowAccount: escrowAccount.publicKey,
        vaultAccount: vault_account_pda,
        vaultAuthority: vault_authority_pda,
        tokenProgram: TOKEN_PROGRAM_ID
      },
      signers: [takerMainAccount]
    });

    let _takerTokenAccountA = await mintA.getAccountInfo(takerTokenAccountA);
    let _takerTokenAccountB = await mintB.getAccountInfo(takerTokenAccountB);
    let _initializerTokenAccountA = await mintA.getAccountInfo(initializerTokenAccountA);
    let _initializerTokenAccountB = await mintB.getAccountInfo(initializerTokenAccountB);

    // Todo assert if the pda account is closed - can do this by calling getAccountInfo on the pda account - should produce error
    await assert.rejects(mintA.getAccountInfo(vault_account_pda));

    assert.ok(_takerTokenAccountA.amount.toNumber() == initializerAmount);
    assert.ok(_initializerTokenAccountA.amount.toNumber() == 0);
    assert.ok(_initializerTokenAccountB.amount.toNumber() == takerAmount);
    assert.ok(_takerTokenAccountB.amount.toNumber() == 0);

    let _initializerAccountEnd = await provider.connection.getBalance(initializerMainAccount.publicKey);
    let _takerAccountEnd = await provider.connection.getBalance(takerMainAccount.publicKey);

    console.log("Balance initializer: ", _initializerAccountEnd);
    console.log("Balance taker: ", _takerAccountEnd);
  });

  it("Cancels correctly", async() => {
    // put tokens in initializerTokenAccountA again
    await mintA.mintTo(
      initializerTokenAccountA, // address of the account to send the minted tokens to
      mintAuthority.publicKey, // public key of the person who has the minting authority over the token
      [mintAuthority], // signers address
      initializerAmount // amount
    );

    await program.rpc.initializeEscrow(
      vault_account_bump,
      new anchor.BN(initializerAmount),
      new anchor.BN(takerAmount),
      {
        accounts: {
          initializer: initializerMainAccount.publicKey,
          mint: mintA.publicKey, // why mint A - because this is the mint that the initializer is transferring
          vaultAccount: vault_account_pda, // a pda is a public key that doesn't have a private key, so this is already a publicKey
          initializerDepositTokenAccount: initializerTokenAccountA, // a minted account is a public key seemingly
          initializerReceiveTokenAccount: initializerTokenAccountB,
          escrowAccount: escrowAccount.publicKey,
          systemProgram: anchor.web3.SystemProgram.programId, // just need to remember how to pass in the system program
          rent: anchor.web3.SYSVAR_RENT_PUBKEY, // just need to remember how to pass in the rent 
          tokenProgram: TOKEN_PROGRAM_ID // the token program defines a common implementation for fungible and non-fungible tokens
        },
        instructions: [
          await program.account.escrowAccount.createInstruction(escrowAccount), // don't get this instruction
        ],
        signers: [escrowAccount, initializerMainAccount], // don't get why the escrowAccount is included here? Maybe should be vaultAccount?
      }
    );

    // cancel the escrow
    await program.rpc.cancelEscrow({
      accounts: {
        initializer: initializerMainAccount.publicKey,
        vaultAccount: vault_account_pda,
        vaultAuthority: vault_authority_pda,
        initializerDepositTokenAccount: initializerTokenAccountA,
        escrowAccount: escrowAccount.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID
      },
      signers: [initializerMainAccount]
    });

    // check that pda account closed
    await assert.rejects(mintA.getAccountInfo(vault_account_pda));

    let _initializerTokenAccountA = await mintA.getAccountInfo(initializerTokenAccountA);
    // check that the initializer is the owner of their token A account again
    assert.ok(_initializerTokenAccountA.owner.equals(initializerMainAccount.publicKey));
    // check that the funds were returned to their account
    assert.ok(_initializerTokenAccountA.amount.toNumber() == initializerAmount);
  });
});
