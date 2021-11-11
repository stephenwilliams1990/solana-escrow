## Escrow program in Solana

This is a program used to exchange tokens in an escrow on Solana. 

## Build, Deploy and Test

After cloning the repository, first install dependencies:

$ npm install

Install Anchor (if you don't have it installed already):

$ cargo install --git https://github.com/project-serum/anchor --tag v0.18.0 anchor-cli --locked

Build the program:

$ anchor build

Deploy the program:

$ anchor deploy

Then you can run tests by running

$ anchor test
