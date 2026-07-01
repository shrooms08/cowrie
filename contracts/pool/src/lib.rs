#![no_std]
//! Cowrie privacy pool — commitment tree + nullifier set + spend entrypoint.
//!
//! Fixed denominations {1,5,10,50} (no change notes for now). The pool is the
//! on-chain state the `policy_tx_2_2` verifier checks against:
//!   - a Poseidon2 commitment Merkle tree with recent-root history (deposits),
//!   - a spent-nullifier set (double-spend prevention),
//!   - `spend()`, which binds the merchant + payout to the verified proof and is
//!     the SOLE source of truth for which pool/ASP roots are acceptable.
//!
//! Token transfer-in (deposit) and payout (spend) are MOCKED for the demo
//! (flagged). Real USDC SAC integration is Phase 5/6.

mod merkle;

use merkle::MerkleTreeWithHistory;
use soroban_sdk::{
    contract, contractclient, contracterror, contractevent, contractimpl, contracttype, Address,
    Bytes, Env, Map, Vec, U256,
};
use soroban_utils::{bn256_modulus, poseidon2_hash2};

const LEVELS: u32 = 10;
/// Domain separator for the merchant/payout binding hash (distinct from the
/// circuit's 1..4 separators).
const EXT_DOM: u32 = 5;

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
    /// The canonical "dummy" nullifier for the 2-in circuit shape. Slot 0 of a
    /// single-real-note spend is a fixed, amount-0, structurally-inert input;
    /// its nullifier is the SAME on every spend. It carries no value (the
    /// circuit's amount invariant forces value onto a real input whose nullifier
    /// differs), so `spend()` never records it — otherwise the 2nd distinct
    /// spend would falsely collide. Wired at deploy time.
    DummyNullifier,
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
    /// Merchant identifier (field element) — bound by the proof, not trusted
    /// from the caller. Only emitted after the proof verifies.
    merchant: U256,
    payout: u32,
    nullifier: U256,
}

/// Emitted for each output (change-note) commitment inserted into the tree, so
/// the payer can locate and later spend their change. The commitment is bound
/// by the verified proof (`outputCommitment`); the index/root come from the tree.
#[contractevent(topics = ["ChangeNote"])]
struct ChangeNoteEvent {
    commitment: U256,
    index: u32,
    root: U256,
}

// ---- cross-contract clients ----
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
    /// Wire the verifier + ASP contracts, the canonical dummy nullifier, and
    /// initialize the commitment tree.
    pub fn __constructor(
        env: Env,
        verifier: Address,
        asp: Address,
        dummy_nullifier: U256,
    ) -> Result<(), Error> {
        let s = env.storage().persistent();
        if s.has(&DataKey::Verifier) {
            return Err(Error::AlreadyInitialized);
        }
        s.set(&DataKey::Verifier, &verifier);
        s.set(&DataKey::Asp, &asp);
        s.set(&DataKey::DummyNullifier, &dummy_nullifier);
        s.set(&DataKey::Nullifiers, &Map::<U256, bool>::new(&env));
        MerkleTreeWithHistory::init(&env, LEVELS).map_err(|_| Error::Internal)?;
        Ok(())
    }

    /// The canonical dummy nullifier that `spend()` ignores.
    pub fn dummy_nullifier(env: Env) -> Result<U256, Error> {
        env.storage().persistent().get(&DataKey::DummyNullifier).ok_or(Error::NotInitialized)
    }

    /// Deposit a fixed-denomination note. Inserts `commitment` as a leaf.
    /// ⚠️ MOCK: the USDC transfer-in is not performed here (Phase 5/6).
    pub fn deposit(env: Env, amount: u32, commitment: U256) -> Result<u32, Error> {
        if !(amount == 1 || amount == 5 || amount == 10 || amount == 50) {
            return Err(Error::BadDenomination);
        }
        let index =
            MerkleTreeWithHistory::insert_leaf(&env, commitment.clone()).map_err(|e| match e {
                merkle::MerkleError::TreeFull => Error::TreeFull,
                _ => Error::Internal,
            })?;
        let root = MerkleTreeWithHistory::get_last_root(&env).map_err(|_| Error::Internal)?;
        DepositEvent { amount, commitment, index, root }.publish(&env);
        Ok(index)
    }

    /// Current pool commitment root.
    pub fn get_root(env: Env) -> Result<U256, Error> {
        MerkleTreeWithHistory::get_last_root(&env).map_err(|_| Error::NotInitialized)
    }

    pub fn is_known_root(env: Env, root: U256) -> Result<bool, Error> {
        MerkleTreeWithHistory::is_known_root(&env, &root).map_err(|_| Error::NotInitialized)
    }

    pub fn is_spent(env: Env, nullifier: U256) -> Result<bool, Error> {
        Ok(Self::nullifiers(&env)?.get(nullifier).unwrap_or(false))
    }

    /// Spend a note to a merchant. The merchant + payout are bound to the proof
    /// (via the `extDataHash` / `publicAmount` public inputs); the contract
    /// trusts ONLY the verified public inputs.
    ///
    /// Public inputs are passed structured, in the circuit's declared order:
    ///   [root, public_amount, ext_data_hash,
    ///    input_nullifiers(2), output_commitments(2),
    ///    asp_membership_root(2), asp_non_membership_root(2)]
    /// The roots are duplicated once per circuit input; the pool takes a single
    /// value for each and replicates while building the verifier input.
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
    ) -> Result<(), Error> {
        if input_nullifiers.len() != 2 || output_commitments.len() != 2 {
            return Err(Error::BadPublicInputs);
        }
        // Payout is ARBITRARY (deposits are fixed-denomination notes, but a spend
        // can pay any amount and mint a change note for the remainder). Value
        // conservation is enforced inside the circuit (sumIns + publicAmount ===
        // sumOuts) and bound here via public_amount == field − payout, so an
        // out-of-thin-air payout cannot balance. No denomination check on spend.

        // (a) pool root must be in recent history.
        if !MerkleTreeWithHistory::is_known_root(&env, &root).map_err(|_| Error::NotInitialized)? {
            return Err(Error::UnknownRoot);
        }

        // (c) nullifiers must be unspent. The canonical dummy nullifier (slot 0
        // of a single-real-note spend) is amount-0 and value-less, identical on
        // every spend; skip it so distinct spends don't falsely collide.
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

        // merchant + payout binding: ext_data_hash == H(merchant, payout, dom=5)
        let expected_ext = poseidon2_hash2(
            &env,
            merchant.clone(),
            U256::from_u32(&env, payout),
            Some(U256::from_u32(&env, EXT_DOM)),
        );
        if expected_ext != ext_data_hash {
            return Err(Error::ExtDataMismatch);
        }
        // amount leaving the pool must equal the payout: public_amount == field - payout
        let field = bn256_modulus(&env);
        let expected_pa = field.sub(&U256::from_u32(&env, payout));
        if expected_pa != public_amount {
            return Err(Error::WrongPublicAmount);
        }

        // (b) CRITICAL: ASP allowlist root in the proof must equal the LIVE root.
        // The contract — not the prover — is the source of truth.
        let asp = AspClient::new(&env, &Self::asp(&env)?);
        if asp.get_root() != asp_membership_root {
            return Err(Error::AspRootMismatch);
        }
        if asp.get_blocklist_root() != asp_non_membership_root {
            return Err(Error::BlocklistRootMismatch);
        }

        // (d) verify the proof. Build public inputs in circuit order.
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

        // (e) record ONLY real nullifiers (skip the value-less canonical dummy),
        // emit spend event with the VERIFIED merchant.
        let mut nulls = nulls;
        for n in input_nullifiers.iter() {
            if n == dummy {
                continue;
            }
            nulls.set(n.clone(), true);
        }
        Self::set_nullifiers(&env, &nulls);

        // (f) insert the output (change-note) commitments as new leaves. They are
        // bound by the verified proof (outputCommitment public inputs) and the
        // value invariant (sumIns + publicAmount === sumOuts), so the inserted
        // change is guaranteed to balance. The empty zero-note output is skipped
        // (a Poseidon2(0,0,0) commitment carries no value and need not be tracked).
        let zero_out = Self::zero_output_commitment(&env);
        for c in output_commitments.iter() {
            if c == zero_out {
                continue;
            }
            let index = MerkleTreeWithHistory::insert_leaf(&env, c.clone()).map_err(|_| Error::Internal)?;
            let root = MerkleTreeWithHistory::get_last_root(&env).map_err(|_| Error::Internal)?;
            ChangeNoteEvent { commitment: c, index, root }.publish(&env);
        }

        // ⚠️ MOCK payout: a real deployment transfers USDC to the merchant here.
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
    fn dummy(env: &Env) -> Result<U256, Error> {
        env.storage().persistent().get(&DataKey::DummyNullifier).ok_or(Error::NotInitialized)
    }
    /// The commitment of an empty/zero output note: Poseidon2(0, 0, 0, dom=1).
    /// A constant; outputs equal to it carry no value and are not inserted.
    fn zero_output_commitment(env: &Env) -> U256 {
        const Z: [u8; 32] = [
            4, 192, 108, 183, 121, 196, 20, 199, 151, 254, 113, 193, 40, 46, 239, 66, 199, 248, 225,
            110, 161, 118, 155, 248, 162, 36, 114, 121, 206, 129, 208, 208,
        ];
        U256::from_be_bytes(env, &soroban_sdk::Bytes::from_array(env, &Z))
    }
}
