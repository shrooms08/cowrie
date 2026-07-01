#![no_std]
//! Cowrie privacy pool — THROWAWAY USDC-rail variant (Phase R2-0).
//!
//! Identical ZK/accounting logic to `cowrie-pool`, plus a REAL USDC rail:
//!   - `deposit()` PULLS USDC from the user into the pool (token.transfer
//!     from=user → pool) alongside inserting the commitment leaf,
//!   - `spend()` SENDS USDC from the pool to the merchant for the payout
//!     (token.transfer from=pool → merchant), while change stays a private note.
//!
//! USDC is the Stellar Asset Contract (SAC). Note amounts are whole USD (u32);
//! USDC has 7 decimals, so the on-chain transfer amount is `amount * 10^7`.
//!
//! Accounting invariant (held by construction): the pool's USDC balance always
//! equals the total value of outstanding (unspent) notes. A deposit adds `amount`
//! USDC and a note worth `amount`. A spend burns input notes worth `V_in`, mints
//! a change note worth `V_change`, and pays out `payout` USDC where the circuit
//! enforces `V_in = payout + V_change` (value conservation, change range-checked
//! >= 0). So `payout <= V_in`: a spend can NEVER extract more USDC than the note
//! it burns, and pool USDC stays exactly equal to outstanding note value.

mod merkle;

use merkle::MerkleTreeWithHistory;
use soroban_sdk::{
    contract, contractclient, contracterror, contractevent, contractimpl, contracttype,
    token::TokenClient, Address, Bytes, Env, Map, Vec, U256,
};
use soroban_utils::{bn256_modulus, poseidon2_hash2};

const LEVELS: u32 = 10;
const EXT_DOM: u32 = 5;
/// USDC has 7 decimals on Stellar; a whole-USD note amount scales by this.
const USDC_SCALE: i128 = 10_000_000;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    NotInitialized = 1,
    AlreadyInitialized = 2,
    TreeFull = 3,
    BadDenomination = 4,
    UnknownRoot = 5,
    AlreadySpent = 6,
    AspRootMismatch = 7,
    BlocklistRootMismatch = 8,
    ExtDataMismatch = 9,
    WrongPublicAmount = 10,
    InvalidProof = 11,
    BadPublicInputs = 12,
    Internal = 13,
}

#[contracttype]
#[derive(Clone)]
enum DataKey {
    Verifier,
    Asp,
    Nullifiers,
    DummyNullifier,
    /// The USDC Stellar Asset Contract address (the rail).
    Usdc,
}

#[contractevent(topics = ["Deposit"])]
struct DepositEvent {
    amount: u32,
    commitment: U256,
    index: u32,
    root: U256,
}

#[contractevent(topics = ["Spend"])]
struct SpendEvent {
    merchant: U256,
    payout: u32,
    nullifier: U256,
}

#[contractevent(topics = ["ChangeNote"])]
struct ChangeNoteEvent {
    commitment: U256,
    index: u32,
    root: U256,
}

#[contractclient(name = "VerifierClient")]
pub trait VerifierInterface {
    fn verify_bytes(
        env: Env,
        proof: Bytes,
        public_inputs: Bytes,
    ) -> Result<bool, soroban_sdk::Error>;
}

#[contractclient(name = "AspClient")]
pub trait AspInterface {
    fn get_root(env: Env) -> Result<U256, soroban_sdk::Error>;
    fn get_blocklist_root(env: Env) -> Result<U256, soroban_sdk::Error>;
}

#[contract]
pub struct PoolContract;

#[contractimpl]
impl PoolContract {
    /// Wire the verifier + ASP contracts, the canonical dummy nullifier, the USDC
    /// SAC, and initialize the commitment tree.
    pub fn __constructor(
        env: Env,
        verifier: Address,
        asp: Address,
        dummy_nullifier: U256,
        usdc: Address,
    ) -> Result<(), Error> {
        let s = env.storage().persistent();
        if s.has(&DataKey::Verifier) {
            return Err(Error::AlreadyInitialized);
        }
        s.set(&DataKey::Verifier, &verifier);
        s.set(&DataKey::Asp, &asp);
        s.set(&DataKey::DummyNullifier, &dummy_nullifier);
        s.set(&DataKey::Usdc, &usdc);
        s.set(&DataKey::Nullifiers, &Map::<U256, bool>::new(&env));
        MerkleTreeWithHistory::init(&env, LEVELS).map_err(|_| Error::Internal)?;
        Ok(())
    }

    pub fn dummy_nullifier(env: Env) -> Result<U256, Error> {
        env.storage().persistent().get(&DataKey::DummyNullifier).ok_or(Error::NotInitialized)
    }

    pub fn usdc(env: Env) -> Result<Address, Error> {
        env.storage().persistent().get(&DataKey::Usdc).ok_or(Error::NotInitialized)
    }

    /// Deposit a fixed-denomination note, PULLING real USDC from `from` into the
    /// pool. `from` authorizes the token transfer (see report: the deposit tx is
    /// signed by `from`, whose source-account credentials authorize the nested
    /// `usdc.transfer(from -> pool)` sub-invocation).
    pub fn deposit(
        env: Env,
        from: Address,
        amount: u32,
        commitment: U256,
    ) -> Result<u32, Error> {
        if !(amount == 1 || amount == 5 || amount == 10 || amount == 50) {
            return Err(Error::BadDenomination);
        }
        // Authorize `from` at the ROOT of this invocation. The nested
        // `usdc.transfer(from -> pool)` also requires `from`'s auth, but a
        // source-account credential can only authorize the root call — so we
        // root the authorization here, and the transfer sub-invocation is then
        // covered by the same auth subtree. (Without this, a deposit signed only
        // by the user's tx envelope fails with Auth/InvalidAction.)
        from.require_auth();
        // Pull USDC: from -> pool.
        let usdc = TokenClient::new(&env, &Self::usdc_addr(&env)?);
        usdc.transfer(
            &from,
            &env.current_contract_address(),
            &(amount as i128 * USDC_SCALE),
        );

        let index =
            MerkleTreeWithHistory::insert_leaf(&env, commitment.clone()).map_err(|e| match e {
                merkle::MerkleError::TreeFull => Error::TreeFull,
                _ => Error::Internal,
            })?;
        let root = MerkleTreeWithHistory::get_last_root(&env).map_err(|_| Error::Internal)?;
        DepositEvent { amount, commitment, index, root }.publish(&env);
        Ok(index)
    }

    pub fn get_root(env: Env) -> Result<U256, Error> {
        MerkleTreeWithHistory::get_last_root(&env).map_err(|_| Error::NotInitialized)
    }

    pub fn is_known_root(env: Env, root: U256) -> Result<bool, Error> {
        MerkleTreeWithHistory::is_known_root(&env, &root).map_err(|_| Error::NotInitialized)
    }

    pub fn is_spent(env: Env, nullifier: U256) -> Result<bool, Error> {
        Ok(Self::nullifiers(&env)?.get(nullifier).unwrap_or(false))
    }

    /// Spend a note to a merchant, paying REAL USDC out of the pool to
    /// `merchant_addr`. The payout amount is bound to the verified proof
    /// (`public_amount == field - payout`), so the USDC sent always equals the
    /// circuit-enforced payout, which is <= the input note value.
    #[allow(clippy::too_many_arguments)]
    pub fn spend(
        env: Env,
        proof: Bytes,
        root: U256,
        public_amount: U256,
        ext_data_hash: U256,
        input_nullifiers: Vec<U256>,
        output_commitments: Vec<U256>,
        asp_membership_root: U256,
        asp_non_membership_root: U256,
        merchant: U256,
        payout: u32,
        merchant_addr: Address,
    ) -> Result<(), Error> {
        if input_nullifiers.len() != 2 || output_commitments.len() != 2 {
            return Err(Error::BadPublicInputs);
        }

        if !MerkleTreeWithHistory::is_known_root(&env, &root).map_err(|_| Error::NotInitialized)? {
            return Err(Error::UnknownRoot);
        }

        let dummy = Self::dummy(&env)?;
        let nulls = Self::nullifiers(&env)?;
        for n in input_nullifiers.iter() {
            if n == dummy {
                continue;
            }
            if nulls.get(n).unwrap_or(false) {
                return Err(Error::AlreadySpent);
            }
        }

        let expected_ext = poseidon2_hash2(
            &env,
            merchant.clone(),
            U256::from_u32(&env, payout),
            Some(U256::from_u32(&env, EXT_DOM)),
        );
        if expected_ext != ext_data_hash {
            return Err(Error::ExtDataMismatch);
        }
        // The on-chain payout is bound to the circuit's value conservation:
        // public_amount == field - payout. Combined with the circuit invariant
        // (sumIns + publicAmount === sumOuts) and the change range check, this
        // forces payout = V_in - V_change <= V_in. The USDC transfer below uses
        // this same `payout`, so it can never exceed the burned note value.
        let field = bn256_modulus(&env);
        let expected_pa = field.sub(&U256::from_u32(&env, payout));
        if expected_pa != public_amount {
            return Err(Error::WrongPublicAmount);
        }

        let asp = AspClient::new(&env, &Self::asp(&env)?);
        if asp.get_root() != asp_membership_root {
            return Err(Error::AspRootMismatch);
        }
        if asp.get_blocklist_root() != asp_non_membership_root {
            return Err(Error::BlocklistRootMismatch);
        }

        let mut pubs = Bytes::new(&env);
        Self::push_u256(&env, &mut pubs, &root);
        Self::push_u256(&env, &mut pubs, &public_amount);
        Self::push_u256(&env, &mut pubs, &ext_data_hash);
        for n in input_nullifiers.iter() {
            Self::push_u256(&env, &mut pubs, &n);
        }
        for c in output_commitments.iter() {
            Self::push_u256(&env, &mut pubs, &c);
        }
        Self::push_u256(&env, &mut pubs, &asp_membership_root);
        Self::push_u256(&env, &mut pubs, &asp_membership_root);
        Self::push_u256(&env, &mut pubs, &asp_non_membership_root);
        Self::push_u256(&env, &mut pubs, &asp_non_membership_root);

        let verifier = VerifierClient::new(&env, &Self::verifier(&env)?);
        match verifier.try_verify_bytes(&proof, &pubs) {
            Ok(Ok(true)) => {}
            _ => return Err(Error::InvalidProof),
        }

        let mut nulls = nulls;
        for n in input_nullifiers.iter() {
            if n == dummy {
                continue;
            }
            nulls.set(n.clone(), true);
        }
        Self::set_nullifiers(&env, &nulls);

        let zero_out = Self::zero_output_commitment(&env);
        for c in output_commitments.iter() {
            if c == zero_out {
                continue;
            }
            let index = MerkleTreeWithHistory::insert_leaf(&env, c.clone()).map_err(|_| Error::Internal)?;
            let root = MerkleTreeWithHistory::get_last_root(&env).map_err(|_| Error::Internal)?;
            ChangeNoteEvent { commitment: c, index, root }.publish(&env);
        }

        // REAL payout: pool -> merchant, exactly `payout` USDC. The pool is the
        // `from`, so the transfer is authorized implicitly by the pool's own
        // invocation frame (no external signature needed for the pool's funds).
        if payout > 0 {
            let usdc = TokenClient::new(&env, &Self::usdc_addr(&env)?);
            usdc.transfer(
                &env.current_contract_address(),
                &merchant_addr,
                &(payout as i128 * USDC_SCALE),
            );
        }

        SpendEvent {
            merchant,
            payout,
            nullifier: input_nullifiers.get(1).unwrap(),
        }
        .publish(&env);

        Ok(())
    }

    // ---- helpers ----
    fn push_u256(env: &Env, buf: &mut Bytes, v: &U256) {
        let mut tmp = [0u8; 32];
        v.to_be_bytes().copy_into_slice(&mut tmp);
        buf.append(&Bytes::from_array(env, &tmp));
    }

    fn nullifiers(env: &Env) -> Result<Map<U256, bool>, Error> {
        env.storage().persistent().get(&DataKey::Nullifiers).ok_or(Error::NotInitialized)
    }
    fn set_nullifiers(env: &Env, m: &Map<U256, bool>) {
        env.storage().persistent().set(&DataKey::Nullifiers, m);
    }
    fn verifier(env: &Env) -> Result<Address, Error> {
        env.storage().persistent().get(&DataKey::Verifier).ok_or(Error::NotInitialized)
    }
    fn asp(env: &Env) -> Result<Address, Error> {
        env.storage().persistent().get(&DataKey::Asp).ok_or(Error::NotInitialized)
    }
    fn usdc_addr(env: &Env) -> Result<Address, Error> {
        env.storage().persistent().get(&DataKey::Usdc).ok_or(Error::NotInitialized)
    }
    fn dummy(env: &Env) -> Result<U256, Error> {
        env.storage().persistent().get(&DataKey::DummyNullifier).ok_or(Error::NotInitialized)
    }
    fn zero_output_commitment(env: &Env) -> U256 {
        const Z: [u8; 32] = [
            4, 192, 108, 183, 121, 196, 20, 199, 151, 254, 113, 193, 40, 46, 239, 66, 199, 248, 225,
            110, 161, 118, 155, 248, 162, 36, 114, 121, 206, 129, 208, 208,
        ];
        U256::from_be_bytes(env, &soroban_sdk::Bytes::from_array(env, &Z))
    }
}
