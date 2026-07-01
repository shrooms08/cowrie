//! Fixed-depth Poseidon2 Merkle tree with a ring buffer of recent roots.
//!
//! Single-leaf insertion (Cowrie deposits one commitment at a time). Empty
//! positions use the Poseidon2("XLM") zero-leaf convention (`get_zeroes`),
//! matching the ASP tree and the off-chain witness builder. The root history
//! lets a proof generated against a slightly stale root still verify.

use soroban_sdk::{contracttype, Env, U256};
use soroban_utils::{get_zeroes, poseidon2_compress};

/// Recent roots kept for proof verification. A proof built against any root in
/// this window still validates (tolerates latency between prove and submit).
pub const ROOT_HISTORY_SIZE: u32 = 64;

#[derive(Clone, Debug)]
pub enum MerkleError {
    AlreadyInitialized,
    WrongLevels,
    TreeFull,
    NotInitialized,
    Overflow,
}

#[contracttype]
#[derive(Clone)]
pub enum MerkleKey {
    Levels,
    CurrentRootIndex,
    NextIndex,
    FilledSubtree(u32),
    Zeroes(u32),
    Root(u32),
}

pub struct MerkleTreeWithHistory;

impl MerkleTreeWithHistory {
    pub fn init(env: &Env, levels: u32) -> Result<(), MerkleError> {
        if levels == 0 || levels > 32 {
            return Err(MerkleError::WrongLevels);
        }
        let s = env.storage().persistent();
        if s.has(&MerkleKey::CurrentRootIndex) {
            return Err(MerkleError::AlreadyInitialized);
        }
        s.set(&MerkleKey::Levels, &levels);
        let zeroes = get_zeroes(env);
        for i in 0..=levels {
            let z = zeroes.get(i).ok_or(MerkleError::NotInitialized)?;
            s.set(&MerkleKey::FilledSubtree(i), &z);
            s.set(&MerkleKey::Zeroes(i), &z);
        }
        s.set(&MerkleKey::Root(0), &zeroes.get(levels).ok_or(MerkleError::NotInitialized)?);
        s.set(&MerkleKey::CurrentRootIndex, &0u32);
        s.set(&MerkleKey::NextIndex, &0u64);
        Ok(())
    }

    /// Insert a single leaf at the next index; recompute the path to the root
    /// and push the new root into the history ring. Returns the leaf index.
    pub fn insert_leaf(env: &Env, leaf: U256) -> Result<u32, MerkleError> {
        let s = env.storage().persistent();
        let levels: u32 = s.get(&MerkleKey::Levels).ok_or(MerkleError::NotInitialized)?;
        let next_index: u64 = s.get(&MerkleKey::NextIndex).ok_or(MerkleError::NotInitialized)?;
        let mut root_index: u32 =
            s.get(&MerkleKey::CurrentRootIndex).ok_or(MerkleError::NotInitialized)?;
        let max_leaves = 1u64.checked_shl(levels).ok_or(MerkleError::WrongLevels)?;
        if next_index >= max_leaves {
            return Err(MerkleError::TreeFull);
        }

        let mut current_index = next_index;
        let mut current_hash = leaf;
        for lvl in 0..levels {
            if current_index & 1 == 1 {
                let left: U256 =
                    s.get(&MerkleKey::FilledSubtree(lvl)).ok_or(MerkleError::NotInitialized)?;
                current_hash = poseidon2_compress(env, left, current_hash);
            } else {
                s.set(&MerkleKey::FilledSubtree(lvl), &current_hash);
                let z: U256 = s.get(&MerkleKey::Zeroes(lvl)).ok_or(MerkleError::NotInitialized)?;
                current_hash = poseidon2_compress(env, current_hash, z);
            }
            current_index >>= 1;
        }

        root_index = root_index.checked_add(1).ok_or(MerkleError::Overflow)? % ROOT_HISTORY_SIZE;
        s.set(&MerkleKey::Root(root_index), &current_hash);
        s.set(&MerkleKey::CurrentRootIndex, &root_index);
        s.set(&MerkleKey::NextIndex, &(next_index.checked_add(1).ok_or(MerkleError::Overflow)?));

        u32::try_from(next_index).map_err(|_| MerkleError::TreeFull)
    }

    /// True if `root` is in the recent history ring (zero root never matches).
    pub fn is_known_root(env: &Env, root: &U256) -> Result<bool, MerkleError> {
        if *root == U256::from_u32(env, 0) {
            return Ok(false);
        }
        let s = env.storage().persistent();
        let current: u32 =
            s.get(&MerkleKey::CurrentRootIndex).ok_or(MerkleError::NotInitialized)?;
        let mut i = current;
        loop {
            if let Some(r) = s.get::<MerkleKey, U256>(&MerkleKey::Root(i)) {
                if &r == root {
                    return Ok(true);
                }
            }
            i = i.checked_add(1).ok_or(MerkleError::Overflow)? % ROOT_HISTORY_SIZE;
            if i == current {
                break;
            }
        }
        Ok(false)
    }

    pub fn get_last_root(env: &Env) -> Result<U256, MerkleError> {
        let s = env.storage().persistent();
        let current: u32 =
            s.get(&MerkleKey::CurrentRootIndex).ok_or(MerkleError::NotInitialized)?;
        s.get(&MerkleKey::Root(current)).ok_or(MerkleError::NotInitialized)
    }
}
