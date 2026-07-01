#![no_std]
//! Shared utilities for Cowrie Soroban contracts (Poseidon2 + Merkle zero-hashes
//! + admin helpers). Ported from the reference soroban-utils, trimmed to remove
//! the arkworks VK-byte helpers (not needed: the verifier embeds its VK).

pub mod constants;
pub mod poseidon2;
pub mod utils;

pub use constants::*;
pub use poseidon2::*;
pub use utils::*;
