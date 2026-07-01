#![no_std]
//! Cowrie ASP (Association-Set Provider) contract — the clean-funds gate.
//!
//! Holds the on-chain source of truth for the policy the `policy_tx_2_2` circuit
//! checks against:
//!   - an **allowlist** Poseidon2 Merkle tree (depth 10, same params as the
//!     circuit's membership tree). Each leaf is `H(pubKey, blinding, dom=1)` for
//!     a note the ASP has vouched as clean. `get_root()` exposes the live root.
//!   - a **blocklist** non-membership root. The circuit enforces SMT
//!     non-membership; maintaining a full SMT on-chain is out of scope for the
//!     demo, so the canonical blocklist root is admin-set here and exposed via
//!     `get_blocklist_root()`. The pool checks the proof's nonMembership root
//!     against this value, making the CONTRACT (not the prover) the source of
//!     truth. ⚠️ STAND-IN: a real deployment maintains a live SMT.
//!
//! Admin auth is a simple single-key gate — a STAND-IN for the real ASP service.
//!
//! The allowlist root is recomputed from a stored leaf vector on every
//! add/remove (the demo's leaf count is small). Empty positions use the
//! Poseidon2("XLM") zero-leaf convention from `get_zeroes`, matching the pool
//! tree and the witness builder.

use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, Address, Env, Vec, U256,
};
use soroban_utils::{get_zeroes, poseidon2_compress};

const LEVELS: u32 = 10;

#[contracttype]
#[derive(Clone)]
enum DataKey {
    Admin,
    Leaves,        // Vec<U256> — populated allowlist leaves (index = insertion order)
    Root,          // current allowlist Merkle root
    BlocklistRoot, // admin-set non-membership (blocklist) root
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    NotInitialized = 1,
    TreeFull = 2,
    LeafNotFound = 3,
}

#[contractevent(topics = ["LeafAdded"])]
struct LeafAddedEvent {
    leaf: U256,
    index: u32,
    root: U256,
}

#[contractevent(topics = ["LeafRemoved"])]
struct LeafRemovedEvent {
    index: u32,
    root: U256,
}

#[contract]
pub struct AspContract;

#[contractimpl]
impl AspContract {
    /// Initialize with an admin. Allowlist starts empty; blocklist root starts
    /// at 0 (admin sets the real one via `set_blocklist_root`).
    pub fn __constructor(env: Env, admin: Address) {
        let store = env.storage().persistent();
        store.set(&DataKey::Admin, &admin);
        store.set(&DataKey::Leaves, &Vec::<U256>::new(&env));
        let zeroes = get_zeroes(&env);
        store.set(&DataKey::Root, &zeroes.get(LEVELS).unwrap());
        store.set(&DataKey::BlocklistRoot, &U256::from_u32(&env, 0));
    }

    /// Add a clean-funds leaf to the allowlist. Admin-gated (STAND-IN for ASP).
    /// Returns the index where the leaf was inserted.
    pub fn admin_add(env: Env, leaf: U256) -> Result<u32, Error> {
        Self::admin(&env)?.require_auth();
        let store = env.storage().persistent();
        let mut leaves: Vec<U256> = store.get(&DataKey::Leaves).ok_or(Error::NotInitialized)?;
        if (leaves.len() as u64) >= (1u64 << LEVELS) {
            return Err(Error::TreeFull);
        }
        let index = leaves.len();
        leaves.push_back(leaf.clone());
        store.set(&DataKey::Leaves, &leaves);
        let root = Self::recompute_root(&env, &leaves);
        store.set(&DataKey::Root, &root);
        LeafAddedEvent { leaf, index, root: root.clone() }.publish(&env);
        Ok(index)
    }

    /// Remove a leaf (set its position to the empty value) and recompute the
    /// root. Admin-gated. STAND-IN: real ASPs revoke via the live service.
    pub fn admin_remove(env: Env, leaf: U256) -> Result<(), Error> {
        Self::admin(&env)?.require_auth();
        let store = env.storage().persistent();
        let mut leaves: Vec<U256> = store.get(&DataKey::Leaves).ok_or(Error::NotInitialized)?;
        let empty = get_zeroes(&env).get(0).unwrap();
        let mut found: Option<u32> = None;
        for i in 0..leaves.len() {
            if leaves.get(i).unwrap() == leaf {
                found = Some(i);
                break;
            }
        }
        let idx = found.ok_or(Error::LeafNotFound)?;
        leaves.set(idx, empty);
        store.set(&DataKey::Leaves, &leaves);
        let root = Self::recompute_root(&env, &leaves);
        store.set(&DataKey::Root, &root);
        LeafRemovedEvent { index: idx, root }.publish(&env);
        Ok(())
    }

    /// Current allowlist Merkle root (the circuit's membership root).
    pub fn get_root(env: Env) -> Result<U256, Error> {
        env.storage().persistent().get(&DataKey::Root).ok_or(Error::NotInitialized)
    }

    /// Set the canonical blocklist (non-membership) root. Admin-set STAND-IN.
    pub fn set_blocklist_root(env: Env, root: U256) -> Result<(), Error> {
        Self::admin(&env)?.require_auth();
        env.storage().persistent().set(&DataKey::BlocklistRoot, &root);
        Ok(())
    }

    /// Current blocklist (non-membership) root the prover must match.
    pub fn get_blocklist_root(env: Env) -> Result<U256, Error> {
        env.storage().persistent().get(&DataKey::BlocklistRoot).ok_or(Error::NotInitialized)
    }

    fn admin(env: &Env) -> Result<Address, Error> {
        env.storage().persistent().get(&DataKey::Admin).ok_or(Error::NotInitialized)
    }

    /// Recompute the depth-LEVELS Merkle root from the populated leaf prefix,
    /// padding empty positions with the Poseidon2("XLM") zero subtrees.
    fn recompute_root(env: &Env, leaves: &Vec<U256>) -> U256 {
        let zeroes = get_zeroes(env);
        let mut level = leaves.clone();
        for lvl in 0..LEVELS {
            if level.is_empty() {
                return zeroes.get(LEVELS).unwrap();
            }
            let mut next: Vec<U256> = Vec::new(env);
            let n = level.len();
            let zero_lvl = zeroes.get(lvl).unwrap();
            let mut i = 0u32;
            while i < n {
                let left = level.get(i).unwrap();
                let right = if i + 1 < n { level.get(i + 1).unwrap() } else { zero_lvl.clone() };
                next.push_back(poseidon2_compress(env, left, right));
                i += 2;
            }
            level = next;
        }
        level.get(0).unwrap()
    }
}
