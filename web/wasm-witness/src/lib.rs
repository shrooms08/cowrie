//! Cowrie in-browser witness builder (WASM).
//!
//! Reuses the EXACT proven Poseidon2 (zkhash) + Merkle + SMT logic from the
//! Phase-1/2 Rust witness generator, exposed to JS via wasm-bindgen. This avoids
//! a risky JS Poseidon2 reimplementation: the on-chain contracts, the circuit,
//! and this builder all share one Poseidon2 source of truth.
//!
//! Note model: ONE wallet identity keypair (BN254 priv -> pubkey). Each note is
//! (amount, blinding) sharing the wallet pubkey; its commitment / nullifier are
//! distinct. Slot 0 of every spend is the GLOBAL canonical dummy (amount 0),
//! whose nullifier the pool skips.

use num_bigint::{BigInt, BigUint, Sign};
use num_integer::Integer;
use serde::Serialize;
use serde_json::json;
use std::collections::HashMap;
use std::ops::{AddAssign, Shr};
use wasm_bindgen::prelude::*;
use zkhash::ark_ff::{BigInteger, PrimeField, Zero};
use zkhash::fields::bn256::FpBN256 as Scalar;
use zkhash::poseidon2::poseidon2::Poseidon2;
use zkhash::poseidon2::poseidon2_instance_bn256::{
    POSEIDON2_BN256_PARAMS_2, POSEIDON2_BN256_PARAMS_3, POSEIDON2_BN256_PARAMS_4,
};

const LEVELS: usize = 10;
const SMT_LEVELS: usize = 10;
const EXT_DOM: u64 = 5;
// Global canonical dummy note (matches the value wired into the pool constructor).
const DUMMY_PRIV: u64 = 9001;
const DUMMY_BLIND: u64 = 9002;
// Fixed blocklist keys (the demo's stand-in SMT contents).
const BLOCK_KEYS: [u64; 2] = [666, 777];

// ---------- Poseidon2 (identical to circuit + contracts) ----------
fn p2_compress(left: Scalar, right: Scalar) -> Scalar {
    let h = Poseidon2::new(&POSEIDON2_BN256_PARAMS_2);
    let mut perm = h.permutation(&[left, right]);
    perm[0].add_assign(&left);
    perm[0]
}
fn p2_hash2(a: Scalar, b: Scalar, dom: Scalar) -> Scalar {
    let h = Poseidon2::new(&POSEIDON2_BN256_PARAMS_3);
    h.permutation(&[a, b, dom])[0]
}
fn p2_hash3(a: Scalar, b: Scalar, c: Scalar, dom: Scalar) -> Scalar {
    let h = Poseidon2::new(&POSEIDON2_BN256_PARAMS_4);
    h.permutation(&[a, b, c, dom])[0]
}

fn s(n: u64) -> Scalar {
    Scalar::from(n)
}
fn dec(d: &str) -> Scalar {
    let u = BigUint::parse_bytes(d.as_bytes(), 10).expect("bad decimal");
    Scalar::from(u)
}
fn to_dec(x: Scalar) -> String {
    BigUint::from_bytes_be(&x.into_bigint().to_bytes_be()).to_string()
}
fn to_bi(x: Scalar) -> BigInt {
    BigInt::from(BigUint::from_bytes_be(&x.into_bigint().to_bytes_be()))
}

// ---------- domain functions (match keypair/transaction circuits) ----------
fn derive_pk(priv_k: Scalar) -> Scalar {
    p2_hash2(priv_k, Scalar::zero(), s(3))
}
fn sign(priv_k: Scalar, commit: Scalar, path: Scalar) -> Scalar {
    p2_hash3(priv_k, commit, path, s(4))
}
fn commit(amount: Scalar, pk: Scalar, blinding: Scalar) -> Scalar {
    p2_hash3(amount, pk, blinding, s(1))
}
fn nullifier(commit: Scalar, path: Scalar, sig: Scalar) -> Scalar {
    p2_hash3(commit, path, sig, s(2))
}
fn membership_leaf(pk: Scalar) -> Scalar {
    p2_hash2(pk, Scalar::zero(), s(1))
}

// ---------- Merkle ----------
fn xlm_zero() -> Scalar {
    p2_hash3(s(88), s(76), s(77), s(0))
}
fn full_tree(placements: &[(usize, Scalar)]) -> Vec<Scalar> {
    let mut leaves = vec![xlm_zero(); 1usize << LEVELS];
    for (i, l) in placements {
        leaves[*i] = *l;
    }
    leaves
}
fn merkle_root(mut leaves: Vec<Scalar>) -> Scalar {
    while leaves.len() > 1 {
        let mut next = Vec::with_capacity(leaves.len() / 2);
        for p in leaves.chunks_exact(2) {
            next.push(p2_compress(p[0], p[1]));
        }
        leaves = next;
    }
    leaves[0]
}
fn merkle_proof(leaves: &[Scalar], mut index: usize) -> (Vec<Scalar>, u64) {
    let mut nodes = leaves.to_vec();
    let mut path = Vec::new();
    let mut bits = Vec::new();
    for _ in 0..LEVELS {
        let sib = if index % 2 == 0 { index + 1 } else { index - 1 };
        path.push(nodes[sib]);
        bits.push((index & 1) as u64);
        let mut next = Vec::with_capacity(nodes.len() / 2);
        for p in nodes.chunks_exact(2) {
            next.push(p2_compress(p[0], p[1]));
        }
        nodes = next;
        index /= 2;
    }
    let mut pi = 0u64;
    for (i, b) in bits.iter().enumerate() {
        pi |= b << i;
    }
    (path, pi)
}

// ---------- SMT (blocklist non-membership) ----------
fn field_mod() -> BigInt {
    BigInt::from_bytes_be(Sign::Plus, &Scalar::MODULUS.to_bytes_be())
}
fn big_to_fp(x: &BigInt) -> Scalar {
    let r = x.mod_floor(&field_mod());
    let (_s, b) = r.to_bytes_be();
    Scalar::from(BigUint::from_bytes_be(&b))
}
fn fp_to_big(f: &Scalar) -> BigInt {
    BigInt::from_bytes_be(Sign::Plus, &f.into_bigint().to_bytes_be())
}
fn smt_compress(l: &BigInt, r: &BigInt) -> BigInt {
    fp_to_big(&p2_compress(big_to_fp(l), big_to_fp(r)))
}
fn smt_leaf(k: &BigInt, v: &BigInt) -> BigInt {
    fp_to_big(&p2_hash2(big_to_fp(k), big_to_fp(v), s(1)))
}

struct Smt {
    data: HashMap<BigInt, Vec<BigInt>>,
    root: BigInt,
}
struct Found {
    siblings: Vec<BigInt>,
    not_found_key: BigInt,
    not_found_value: BigInt,
    is_old0: bool,
}
impl Smt {
    fn new() -> Self {
        Self { data: HashMap::new(), root: BigInt::from(0u32) }
    }
    fn bits(k: &BigInt) -> Vec<bool> {
        let mut b = Vec::with_capacity(256);
        let mut k = k.clone();
        for _ in 0..256 {
            b.push(k.bit(0));
            k = k.shr(1u32);
        }
        b
    }
    fn find(&self, key: &BigInt) -> Found {
        self._find(key, &Self::bits(key), &self.root, 0)
    }
    fn _find(&self, key: &BigInt, bits: &[bool], root: &BigInt, lvl: usize) -> Found {
        if *root == BigInt::from(0u32) {
            return Found { siblings: vec![], not_found_key: key.clone(), not_found_value: BigInt::from(0u32), is_old0: true };
        }
        let rec = self.data.get(root).expect("node").clone();
        if rec.len() == 3 && rec[0] == BigInt::from(1u32) {
            if rec[1] == *key {
                Found { siblings: vec![], not_found_key: BigInt::from(0u32), not_found_value: BigInt::from(0u32), is_old0: false }
            } else {
                Found { siblings: vec![], not_found_key: rec[1].clone(), not_found_value: rec[2].clone(), is_old0: false }
            }
        } else {
            let mut res = if !bits[lvl] {
                self._find(key, bits, &rec[0], lvl + 1)
            } else {
                self._find(key, bits, &rec[1], lvl + 1)
            };
            res.siblings.insert(0, if !bits[lvl] { rec[1].clone() } else { rec[0].clone() });
            res
        }
    }
    fn insert(&mut self, key: &BigInt, value: &BigInt) {
        let nkb = Self::bits(key);
        let f = self.find(key);
        let mut siblings = f.siblings.clone();
        let mut rt_old = BigInt::from(0u32);
        let mut added = false;
        if !f.is_old0 {
            let okb = Self::bits(&f.not_found_key);
            let mut i = siblings.len();
            while i < okb.len() && okb[i] == nkb[i] {
                siblings.push(BigInt::from(0u32));
                i += 1;
            }
            rt_old = smt_leaf(&f.not_found_key, &f.not_found_value);
            siblings.push(rt_old.clone());
            added = true;
        }
        let mut mixed = f.is_old0 && !siblings.is_empty();
        let _ = &mut rt_old;
        let mut inserts: Vec<(BigInt, Vec<BigInt>)> = Vec::new();
        let mut rt = smt_leaf(key, value);
        inserts.push((rt.clone(), vec![BigInt::from(1u32), key.clone(), value.clone()]));
        for i in (0..siblings.len()).rev() {
            if i < siblings.len() - 1 && siblings[i] != BigInt::from(0u32) {
                mixed = true;
            }
            if mixed {
                let old = f.siblings[i].clone();
                rt_old = if nkb[i] { smt_compress(&old, &rt_old) } else { smt_compress(&rt_old, &old) };
            }
            let (nrt, node) = if nkb[i] {
                (smt_compress(&siblings[i], &rt), vec![siblings[i].clone(), rt.clone()])
            } else {
                (smt_compress(&rt, &siblings[i]), vec![rt.clone(), siblings[i].clone()])
            };
            inserts.push((nrt.clone(), node));
            rt = nrt;
        }
        if added {
            siblings.pop();
        }
        for (k, v) in inserts {
            self.data.insert(k, v);
        }
        self.root = rt;
    }
}
struct SmtProof {
    siblings: Vec<BigInt>,
    not_found_key: BigInt,
    not_found_value: BigInt,
    is_old0: bool,
    root: BigInt,
}
fn smt_nonmembership(key: &BigInt) -> SmtProof {
    let mut t = Smt::new();
    for k in BLOCK_KEYS {
        t.insert(&BigInt::from(k), &BigInt::from(1u32));
    }
    let f = t.find(key);
    let mut siblings = f.siblings.clone();
    while siblings.len() < SMT_LEVELS {
        siblings.push(BigInt::from(0u32));
    }
    SmtProof { siblings, not_found_key: f.not_found_key, not_found_value: f.not_found_value, is_old0: f.is_old0, root: t.root }
}

// ---------- exported helpers ----------
#[wasm_bindgen]
pub fn derive_pubkey(priv_dec: &str) -> String {
    to_dec(derive_pk(dec(priv_dec)))
}
#[wasm_bindgen]
pub fn asp_leaf_for(priv_dec: &str) -> String {
    to_dec(membership_leaf(derive_pk(dec(priv_dec))))
}
#[wasm_bindgen]
pub fn note_commitment(amount: u32, priv_dec: &str, blinding_dec: &str) -> String {
    to_dec(commit(s(amount as u64), derive_pk(dec(priv_dec)), dec(blinding_dec)))
}
#[wasm_bindgen]
pub fn dummy_asp_leaf() -> String {
    to_dec(membership_leaf(derive_pk(s(DUMMY_PRIV))))
}
/// Nullifier of a note at a given pool path (pathIndices == leaf index). Used to
/// bind a payment-receipt proof to a specific spent note.
#[wasm_bindgen]
pub fn note_nullifier(amount: u32, priv_dec: &str, blinding_dec: &str, path_indices: u32) -> String {
    let pk = derive_pk(dec(priv_dec));
    let cm = commit(s(amount as u64), pk, dec(blinding_dec));
    let sig = sign(dec(priv_dec), cm, s(path_indices as u64));
    to_dec(nullifier(cm, s(path_indices as u64), sig))
}
#[wasm_bindgen]
pub fn dummy_nullifier() -> String {
    // dummy at pool index 0 -> pathIndices = 0
    let pk = derive_pk(s(DUMMY_PRIV));
    let cm = commit(s(0), pk, s(DUMMY_BLIND));
    let sig = sign(s(DUMMY_PRIV), cm, s(0));
    to_dec(nullifier(cm, s(0), sig))
}
#[wasm_bindgen]
pub fn blocklist_root() -> String {
    smt_nonmembership(&BigInt::from(1u32)).root.to_string()
}

/// Pool/ASP Merkle root for a populated leaf prefix (decimal JSON array),
/// padding with the Poseidon2("XLM") zero-leaf. Matches the contracts exactly —
/// used for deposit-resilience checks (did my deposit land?).
#[wasm_bindgen]
pub fn merkle_root_of(leaves_json: &str) -> String {
    let leaves_dec: Vec<String> = serde_json::from_str(leaves_json).expect("leaves");
    let placements: Vec<(usize, Scalar)> =
        leaves_dec.iter().enumerate().map(|(i, d)| (i, dec(d))).collect();
    to_dec(merkle_root(full_tree(&placements)))
}

#[derive(Serialize)]
struct SpendOut {
    input: serde_json::Value,
    root: String,
    public_amount: String,
    ext_data_hash: String,
    input_nullifiers: [String; 2],
    output_commitments: [String; 2],
    asp_membership_root: String,
    asp_non_membership_root: String,
    merchant: String,
    payout: u32,
    real_nullifier: String,
}

/// Build the full circom input.json + the structured spend() params for a spend
/// of the wallet's note (slot 1) plus the global canonical dummy (slot 0).
#[allow(clippy::too_many_arguments)]
#[wasm_bindgen]
pub fn build_spend(
    wallet_priv_dec: &str,
    note_blinding_dec: &str,
    note_amount: u32,
    note_pool_index: u32,
    pool_leaves_json: &str,  // JSON array of decimal commitment strings, index order
    asp_leaves_json: &str,   // JSON array of decimal ASP leaf strings, index order
    note_asp_index: u32,
    dummy_asp_index: u32,
    merchant_dec: &str,
    payout: u32,
) -> String {
    let pool_dec: Vec<String> = serde_json::from_str(pool_leaves_json).expect("pool_leaves");
    let asp_dec: Vec<String> = serde_json::from_str(asp_leaves_json).expect("asp_leaves");

    let pool_placements: Vec<(usize, Scalar)> =
        pool_dec.iter().enumerate().map(|(i, d)| (i, dec(d))).collect();
    let asp_placements: Vec<(usize, Scalar)> =
        asp_dec.iter().enumerate().map(|(i, d)| (i, dec(d))).collect();
    let pool_leaves = full_tree(&pool_placements);
    let asp_leaves = full_tree(&asp_placements);
    let pool_root = merkle_root(pool_leaves.clone());
    let asp_root = merkle_root(asp_leaves.clone());

    // inputs: [dummy(slot0), real note(slot1)]
    let wpriv = dec(wallet_priv_dec);
    let dummy = (s(DUMMY_PRIV), s(DUMMY_BLIND), s(0u64), 0usize, dummy_asp_index as usize);
    let real = (wpriv, dec(note_blinding_dec), s(note_amount as u64), note_pool_index as usize, note_asp_index as usize);
    let inputs = [dummy, real];

    let mut in_amount = Vec::new();
    let mut in_priv = Vec::new();
    let mut in_blind = Vec::new();
    let mut in_pidx = Vec::new();
    let mut in_path: Vec<Vec<String>> = Vec::new();
    let mut nulls = Vec::new();
    let mut mem_leaf = Vec::new();
    let mut mem_pidx = Vec::new();
    let mut mem_path: Vec<Vec<String>> = Vec::new();
    let mut nm = Vec::new();

    for (priv_k, blind, amount, pool_i, asp_i) in inputs.iter().cloned() {
        let pk = derive_pk(priv_k);
        let cm = commit(amount, pk, blind);
        let (sib, pidx) = merkle_proof(&pool_leaves, pool_i);
        let sig = sign(priv_k, cm, s(pidx));
        nulls.push(nullifier(cm, s(pidx), sig));
        in_amount.push(to_dec(amount));
        in_priv.push(to_dec(priv_k));
        in_blind.push(to_dec(blind));
        in_pidx.push(to_dec(s(pidx)));
        in_path.push(sib.iter().map(|x| to_dec(*x)).collect());

        let (msib, mpidx) = merkle_proof(&asp_leaves, asp_i);
        mem_leaf.push(to_dec(membership_leaf(pk)));
        mem_pidx.push(to_dec(s(mpidx)));
        mem_path.push(msib.iter().map(|x| to_dec(*x)).collect());

        let proof = smt_nonmembership(&to_bi(pk));
        nm.push(proof);
    }

    let out_commit = commit(s(0), Scalar::zero(), Scalar::zero());
    let field = field_mod();
    let public_amount = &field - BigInt::from(payout);
    let merchant = dec(merchant_dec);
    let ext = p2_hash2(merchant, s(payout as u64), s(EXT_DOM));
    let bl_root = nm[0].root.clone();

    let membership_proofs: Vec<serde_json::Value> = (0..2).map(|i| json!([{
        "leaf": mem_leaf[i], "blinding": "0",
        "pathElements": mem_path[i], "pathIndices": mem_pidx[i],
    }])).collect();
    let non_membership_proofs: Vec<serde_json::Value> = (0..2).map(|i| {
        let p = &nm[i];
        let (ok, ov, io) = if p.is_old0 {
            ("0".to_string(), "0".to_string(), "1".to_string())
        } else {
            (p.not_found_key.to_string(), p.not_found_value.to_string(), "0".to_string())
        };
        json!([{
            "key": to_bi(derive_pk(inputs[i].0)).to_string(),
            "siblings": p.siblings.iter().map(|x| x.to_string()).collect::<Vec<_>>(),
            "oldKey": ok, "oldValue": ov, "isOld0": io,
        }])
    }).collect();

    let input = json!({
        "root": to_dec(pool_root),
        "publicAmount": public_amount.to_string(),
        "extDataHash": to_dec(ext),
        "inputNullifier": [to_dec(nulls[0]), to_dec(nulls[1])],
        "outputCommitment": [to_dec(out_commit), to_dec(out_commit)],
        "membershipRoots": [[to_dec(asp_root)], [to_dec(asp_root)]],
        "nonMembershipRoots": [[bl_root.to_string()], [bl_root.to_string()]],
        "membershipProofs": membership_proofs,
        "nonMembershipProofs": non_membership_proofs,
        "inAmount": in_amount,
        "inPrivateKey": in_priv,
        "inBlinding": in_blind,
        "inPathIndices": in_pidx,
        "inPathElements": in_path,
        "outAmount": ["0", "0"],
        "outPubkey": ["0", "0"],
        "outBlinding": ["0", "0"],
    });

    let out = SpendOut {
        input,
        root: to_dec(pool_root),
        public_amount: public_amount.to_string(),
        ext_data_hash: to_dec(ext),
        input_nullifiers: [to_dec(nulls[0]), to_dec(nulls[1])],
        output_commitments: [to_dec(out_commit), to_dec(out_commit)],
        asp_membership_root: to_dec(asp_root),
        asp_non_membership_root: bl_root.to_string(),
        merchant: to_dec(merchant),
        payout,
        real_nullifier: to_dec(nulls[1]),
    };
    serde_json::to_string(&out).unwrap()
}

// ---------- generalized spend with arbitrary amount + change ----------

#[derive(serde::Deserialize)]
struct InSlot { priv_dec: String, blinding_dec: String, amount: u32, pool_index: u32, asp_index: u32 }
#[derive(serde::Deserialize)]
struct OutSlot { pubkey_dec: String, blinding_dec: String, amount: u32 }
#[derive(serde::Deserialize)]
struct SpendCfg {
    inputs: Vec<InSlot>,   // exactly 2 (slot0, slot1) — each real or the canonical dummy
    outputs: Vec<OutSlot>, // exactly 2 (slot0 = change owned by payer, slot1 = zero/extra)
    pool_leaves: Vec<String>,
    asp_leaves: Vec<String>,
    merchant_dec: String,
    payout: u32,
}

#[derive(Serialize)]
struct SpendOutFull {
    input: serde_json::Value,
    root: String,
    public_amount: String,
    ext_data_hash: String,
    input_nullifiers: [String; 2],
    output_commitments: [String; 2],
    asp_membership_root: String,
    asp_non_membership_root: String,
    merchant: String,
    payout: u32,
    input_real_nullifiers: Vec<String>, // nullifiers of the non-dummy inputs (to record/burn)
}

/// Build a spend witness with EXPLICIT 2 inputs and 2 outputs. Supports
/// arbitrary payout + a change note (outputs[0]) owned by the payer, and two
/// real inputs (combine notes). Value conservation is enforced by the circuit
/// (`sumIns + publicAmount === sumOuts`), not here — a non-balancing config
/// simply fails witness generation downstream.
#[wasm_bindgen]
pub fn build_spend_change(config_json: &str) -> String {
    let cfg: SpendCfg = serde_json::from_str(config_json).expect("config");
    assert!(cfg.inputs.len() == 2 && cfg.outputs.len() == 2, "need 2 inputs + 2 outputs");

    let pool_placements: Vec<(usize, Scalar)> =
        cfg.pool_leaves.iter().enumerate().map(|(i, d)| (i, dec(d))).collect();
    let asp_placements: Vec<(usize, Scalar)> =
        cfg.asp_leaves.iter().enumerate().map(|(i, d)| (i, dec(d))).collect();
    let pool_leaves = full_tree(&pool_placements);
    let asp_leaves = full_tree(&asp_placements);
    let pool_root = merkle_root(pool_leaves.clone());
    let asp_root = merkle_root(asp_leaves.clone());

    let dummy_pk = derive_pk(s(DUMMY_PRIV));
    let dummy_null = {
        let cm = commit(s(0), dummy_pk, s(DUMMY_BLIND));
        let sig = sign(s(DUMMY_PRIV), cm, s(0));
        nullifier(cm, s(0), sig)
    };

    let mut in_amount = Vec::new();
    let mut in_priv = Vec::new();
    let mut in_blind = Vec::new();
    let mut in_pidx = Vec::new();
    let mut in_path: Vec<Vec<String>> = Vec::new();
    let mut nulls = Vec::new();
    let mut mem_leaf = Vec::new();
    let mut mem_pidx = Vec::new();
    let mut mem_path: Vec<Vec<String>> = Vec::new();
    let mut nm = Vec::new();
    let mut input_pks = Vec::new();

    for slot in cfg.inputs.iter() {
        let priv_k = dec(&slot.priv_dec);
        let blind = dec(&slot.blinding_dec);
        let amount = s(slot.amount as u64);
        let pk = derive_pk(priv_k);
        input_pks.push(pk);
        let cm = commit(amount, pk, blind);
        let (sib, pidx) = merkle_proof(&pool_leaves, slot.pool_index as usize);
        let sig = sign(priv_k, cm, s(pidx));
        nulls.push(nullifier(cm, s(pidx), sig));
        in_amount.push(to_dec(amount));
        in_priv.push(to_dec(priv_k));
        in_blind.push(to_dec(blind));
        in_pidx.push(to_dec(s(pidx)));
        in_path.push(sib.iter().map(|x| to_dec(*x)).collect());

        let (msib, mpidx) = merkle_proof(&asp_leaves, slot.asp_index as usize);
        mem_leaf.push(to_dec(membership_leaf(pk)));
        mem_pidx.push(to_dec(s(mpidx)));
        mem_path.push(msib.iter().map(|x| to_dec(*x)).collect());

        nm.push(smt_nonmembership(&to_bi(pk)));
    }

    // outputs (incl change). commitment = H(amount, pubkey, blinding, dom=1).
    let mut out_amount = Vec::new();
    let mut out_pubkey = Vec::new();
    let mut out_blind = Vec::new();
    let mut out_commits = Vec::new();
    for o in cfg.outputs.iter() {
        let amt = s(o.amount as u64);
        let pk = dec(&o.pubkey_dec);
        let bl = dec(&o.blinding_dec);
        out_amount.push(to_dec(amt));
        out_pubkey.push(to_dec(pk));
        out_blind.push(to_dec(bl));
        out_commits.push(commit(amt, pk, bl));
    }

    let field = field_mod();
    let public_amount = &field - BigInt::from(cfg.payout);
    let merchant = dec(&cfg.merchant_dec);
    let ext = p2_hash2(merchant, s(cfg.payout as u64), s(EXT_DOM));
    let bl_root = nm[0].root.clone();

    let membership_proofs: Vec<serde_json::Value> = (0..2).map(|i| json!([{
        "leaf": mem_leaf[i], "blinding": "0",
        "pathElements": mem_path[i], "pathIndices": mem_pidx[i],
    }])).collect();
    let non_membership_proofs: Vec<serde_json::Value> = (0..2).map(|i| {
        let p = &nm[i];
        let (ok, ov, io) = if p.is_old0 {
            ("0".to_string(), "0".to_string(), "1".to_string())
        } else {
            (p.not_found_key.to_string(), p.not_found_value.to_string(), "0".to_string())
        };
        json!([{
            "key": to_bi(input_pks[i]).to_string(),
            "siblings": p.siblings.iter().map(|x| x.to_string()).collect::<Vec<_>>(),
            "oldKey": ok, "oldValue": ov, "isOld0": io,
        }])
    }).collect();

    let input = json!({
        "root": to_dec(pool_root),
        "publicAmount": public_amount.to_string(),
        "extDataHash": to_dec(ext),
        "inputNullifier": [to_dec(nulls[0]), to_dec(nulls[1])],
        "outputCommitment": [to_dec(out_commits[0]), to_dec(out_commits[1])],
        "membershipRoots": [[to_dec(asp_root)], [to_dec(asp_root)]],
        "nonMembershipRoots": [[bl_root.to_string()], [bl_root.to_string()]],
        "membershipProofs": membership_proofs,
        "nonMembershipProofs": non_membership_proofs,
        "inAmount": in_amount,
        "inPrivateKey": in_priv,
        "inBlinding": in_blind,
        "inPathIndices": in_pidx,
        "inPathElements": in_path,
        "outAmount": out_amount,
        "outPubkey": out_pubkey,
        "outBlinding": out_blind,
    });

    // real (non-dummy) nullifiers — the ones the pool records/burns
    let real_nulls: Vec<String> = nulls.iter().filter(|n| **n != dummy_null).map(|n| to_dec(*n)).collect();

    let out = SpendOutFull {
        input,
        root: to_dec(pool_root),
        public_amount: public_amount.to_string(),
        ext_data_hash: to_dec(ext),
        input_nullifiers: [to_dec(nulls[0]), to_dec(nulls[1])],
        output_commitments: [to_dec(out_commits[0]), to_dec(out_commits[1])],
        asp_membership_root: to_dec(asp_root),
        asp_non_membership_root: bl_root.to_string(),
        merchant: to_dec(merchant),
        payout: cfg.payout,
        input_real_nullifiers: real_nulls,
    };
    serde_json::to_string(&out).unwrap()
}

#[wasm_bindgen(start)]
pub fn __wasm_start() { console_error_panic_hook::set_once(); }
