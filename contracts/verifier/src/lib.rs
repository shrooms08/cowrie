#![no_std]
//! Cowrie Groth16 verifier (BN254).
//!
//! Forked from Nethermind `circom-groth16-verifier`. Verifies a Groth16 proof on
//! BN254 using the Protocol 25/26 host functions via `env.crypto().bn254()`:
//! `g1_mul`, `g1_add`, `pairing_check`.
//!
//! The verification key for `policy_tx_2_2` (11 public inputs) is embedded at
//! compile time from `vk.rs`, generated from the trusted-setup
//! `verification_key.json` (see `circuits/scripts/vk_to_rust_const.py`).
//!
//! ⚠️ The embedded VK comes from a DEV-ONLY trusted setup. Regenerate `vk.rs`
//! and redeploy after a real ceremony before production.

use soroban_sdk::{
    contract, contracterror, contractimpl,
    crypto::bn254::{Bn254Fr, Bn254G1Affine as G1Affine, Bn254G2Affine as G2Affine},
    vec, Bytes, BytesN, Env, Vec,
};

mod vk;

/// Errors returned by proof verification.
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Groth16Error {
    InvalidProof = 0,
    MalformedPublicInputs = 1,
    MalformedProof = 2,
}

/// Total proof size: A (G1 64) ‖ B (G2 128, c1‖c0) ‖ C (G1 64) = 256 bytes.
const PROOF_SIZE: u32 = 256;

struct VerificationKey {
    alpha: G1Affine,
    beta: G2Affine,
    gamma: G2Affine,
    delta: G2Affine,
    ic: Vec<G1Affine>,
}

fn embedded_vk(env: &Env) -> VerificationKey {
    let mut ic: Vec<G1Affine> = Vec::new(env);
    for bytes in vk::VK_IC.iter() {
        ic.push_back(G1Affine::from_bytes(BytesN::from_array(env, bytes)));
    }
    VerificationKey {
        alpha: G1Affine::from_bytes(BytesN::from_array(env, &vk::VK_ALPHA_G1)),
        beta: G2Affine::from_bytes(BytesN::from_array(env, &vk::VK_BETA_G2)),
        gamma: G2Affine::from_bytes(BytesN::from_array(env, &vk::VK_GAMMA_G2)),
        delta: G2Affine::from_bytes(BytesN::from_array(env, &vk::VK_DELTA_G2)),
        ic,
    }
}

#[contract]
pub struct VerifierContract;

#[contractimpl]
impl VerifierContract {
    /// Verify a Groth16 proof against the embedded VK.
    ///
    /// - `proof`: 256 raw bytes (A‖B‖C; B in Soroban c1‖c0 ordering).
    /// - `public_inputs`: concatenated 32-byte big-endian field elements
    ///   (11 for `policy_tx_2_2`, in circuit declaration order).
    ///
    /// Returns `Ok(true)` on a valid proof; an invalid proof either trips a
    /// host-function trap (malformed points) or returns `InvalidProof`.
    pub fn verify_bytes(
        env: Env,
        proof: Bytes,
        public_inputs: Bytes,
    ) -> Result<bool, Groth16Error> {
        if proof.len() != PROOF_SIZE {
            return Err(Groth16Error::MalformedProof);
        }
        let a = G1Affine::from_bytes(
            proof
                .slice(0..64)
                .try_into()
                .map_err(|_| Groth16Error::MalformedProof)?,
        );
        let b = G2Affine::from_bytes(
            proof
                .slice(64..192)
                .try_into()
                .map_err(|_| Groth16Error::MalformedProof)?,
        );
        let c = G1Affine::from_bytes(
            proof
                .slice(192..256)
                .try_into()
                .map_err(|_| Groth16Error::MalformedProof)?,
        );

        let n = public_inputs.len();
        if n % 32 != 0 {
            return Err(Groth16Error::MalformedPublicInputs);
        }
        let mut pubs: Vec<Bn254Fr> = Vec::new(&env);
        let mut i = 0u32;
        while i < n {
            let chunk: BytesN<32> = public_inputs
                .slice(i..i + 32)
                .try_into()
                .map_err(|_| Groth16Error::MalformedPublicInputs)?;
            pubs.push_back(Bn254Fr::from_bytes(chunk));
            i += 32;
        }

        let vk = embedded_vk(&env);
        let bn = env.crypto().bn254();

        if pubs.len().checked_add(1) != Some(vk.ic.len()) {
            return Err(Groth16Error::MalformedPublicInputs);
        }

        // vk_x = IC[0] + Σ pub_i · IC[i+1]
        let mut vk_x = vk.ic.get(0).ok_or(Groth16Error::MalformedPublicInputs)?;
        for j in 0..pubs.len() {
            let s = pubs.get(j).ok_or(Groth16Error::MalformedPublicInputs)?;
            let v = vk
                .ic
                .get(j + 1)
                .ok_or(Groth16Error::MalformedPublicInputs)?;
            let prod = bn.g1_mul(&v, &s);
            vk_x = bn.g1_add(&vk_x, &prod);
        }

        // e(-A,B)·e(alpha,beta)·e(vk_x,gamma)·e(C,delta) == 1
        #[allow(clippy::arithmetic_side_effects)]
        let neg_a = -a;
        let g1_points = vec![&env, neg_a, vk.alpha, vk_x, c];
        let g2_points = vec![&env, b, vk.beta, vk.gamma, vk.delta];
        if bn.pairing_check(g1_points, g2_points) {
            Ok(true)
        } else {
            Err(Groth16Error::InvalidProof)
        }
    }
}
