//! Cowrie witness generator for the policy_tx_2_2 circuit.
//!
//! Faithful port of the reference's pure-Rust witness builder
//! (Poseidon2 via vendored zkhash, Merkle, SMT, keypair, transaction).
//! Emits a circom/snarkjs-compatible `input.json` describing a REAL spend:
//!   - an unspent note that is a leaf in the pool commitment tree (Merkle membership)
//!   - that same note's membership in the ASP allowlist tree (clean funds)
//!   - that same note's NON-membership in the blocklist SMT
//!   - revealed nullifier + public binding (publicAmount, extDataHash)
//!
//! Two modes:
//!   `valid`   -> a satisfiable witness (proof should generate + verify)
//!   `bad-asp` -> identical EXCEPT the note's leaf is NOT placed in the ASP
//!               allowlist tree (membership root won't match) -> witness MUST fail.

use anyhow::Result;
use num_bigint::{BigInt, BigUint, Sign};
use num_integer::Integer;
use serde_json::json;
use std::collections::HashMap;
use std::ops::{AddAssign, Shr};
use zkhash::ark_ff::{BigInteger, PrimeField, Zero};
use zkhash::fields::bn256::FpBN256 as Scalar;
use zkhash::poseidon2::poseidon2::Poseidon2;
use zkhash::poseidon2::poseidon2_instance_bn256::{
    POSEIDON2_BN256_PARAMS_2, POSEIDON2_BN256_PARAMS_3, POSEIDON2_BN256_PARAMS_4,
};

const LEVELS: usize = 10;
const SMT_LEVELS: usize = 10;

// ---------- Poseidon2 (matches circom poseidon2_* + reference general.rs) ----------

fn poseidon2_compression(left: Scalar, right: Scalar) -> Scalar {
    let h = Poseidon2::new(&POSEIDON2_BN256_PARAMS_2);
    let mut perm = h.permutation(&[left, right]);
    perm[0].add_assign(&left);
    perm[0]
}

fn poseidon2_hash2(a: Scalar, b: Scalar, dom: Option<Scalar>) -> Scalar {
    let h = Poseidon2::new(&POSEIDON2_BN256_PARAMS_3);
    let perm = h.permutation(&[a, b, dom.unwrap_or_else(|| Scalar::from(0u64))]);
    perm[0]
}

fn poseidon2_hash3(a: Scalar, b: Scalar, c: Scalar, dom: Option<Scalar>) -> Scalar {
    let h = Poseidon2::new(&POSEIDON2_BN256_PARAMS_4);
    let perm = h.permutation(&[a, b, c, dom.unwrap_or_else(|| Scalar::from(0u64))]);
    perm[0]
}

fn scalar_to_dec(s: Scalar) -> String {
    let be = s.into_bigint().to_bytes_be();
    BigUint::from_bytes_be(&be).to_string()
}
fn scalar_to_bigint(s: Scalar) -> BigInt {
    let be = s.into_bigint().to_bytes_be();
    BigInt::from(BigUint::from_bytes_be(&be))
}
fn bigint_to_dec(b: &BigInt) -> String {
    b.to_string()
}

// ---------- keypair / transaction ----------

fn derive_public_key(priv_key: Scalar) -> Scalar {
    poseidon2_hash2(priv_key, Scalar::zero(), Some(Scalar::from(3u64)))
}
fn sign(priv_key: Scalar, commitment: Scalar, merkle_path: Scalar) -> Scalar {
    poseidon2_hash3(priv_key, commitment, merkle_path, Some(Scalar::from(4u64)))
}
fn commitment(amount: Scalar, pubkey: Scalar, blinding: Scalar) -> Scalar {
    poseidon2_hash3(amount, pubkey, blinding, Some(Scalar::from(1u64)))
}
fn nullifier(commitment: Scalar, path_indices: Scalar, signature: Scalar) -> Scalar {
    poseidon2_hash3(commitment, path_indices, signature, Some(Scalar::from(2u64)))
}

// ---------- Merkle ----------

fn merkle_root(mut leaves: Vec<Scalar>) -> Scalar {
    assert!(!leaves.is_empty() && leaves.len().is_power_of_two());
    while leaves.len() > 1 {
        let mut next = Vec::with_capacity(leaves.len() / 2);
        for pair in leaves.chunks_exact(2) {
            next.push(poseidon2_compression(pair[0], pair[1]));
        }
        leaves = next;
    }
    leaves[0]
}

fn merkle_proof(leaves: &[Scalar], mut index: usize) -> (Vec<Scalar>, u64, usize) {
    let mut nodes = leaves.to_vec();
    let levels = nodes.len().ilog2() as usize;
    let mut path = Vec::with_capacity(levels);
    let mut bits = Vec::with_capacity(levels);
    for _ in 0..levels {
        let sib = if index % 2 == 0 { index + 1 } else { index - 1 };
        path.push(nodes[sib]);
        bits.push((index & 1) as u64);
        let mut next = Vec::with_capacity(nodes.len() / 2);
        for pair in nodes.chunks_exact(2) {
            next.push(poseidon2_compression(pair[0], pair[1]));
        }
        nodes = next;
        index /= 2;
    }
    let mut path_indices = 0u64;
    for (i, b) in bits.iter().enumerate() {
        path_indices |= b << i;
    }
    (path, path_indices, levels)
}

// Empty-leaf convention MUST match the contracts' `get_zeroes`:
// zero[0] = Poseidon2("XLM") = Poseidon2_t4([88,76,77,0])[0].
fn xlm_zero() -> Scalar {
    poseidon2_hash3(
        Scalar::from(88u64),
        Scalar::from(76u64),
        Scalar::from(77u64),
        Some(Scalar::from(0u64)),
    )
}

/// Build a full 2^levels leaf vector filled with the XLM empty-leaf, then place
/// the given (index, leaf) entries. Matches the contract's incremental tree.
fn build_full_tree(levels: usize, placements: &[(usize, Scalar)]) -> Vec<Scalar> {
    let n = 1usize << levels;
    let mut leaves = vec![xlm_zero(); n];
    for (idx, leaf) in placements {
        leaves[*idx] = *leaf;
    }
    leaves
}

// ---------- Sparse Merkle Tree (port of reference sparse_merkle_tree.rs) ----------

fn field_modulus_bigint() -> BigInt {
    BigInt::from_bytes_be(Sign::Plus, &Scalar::MODULUS.to_bytes_be())
}
fn big_to_fp(x: &BigInt) -> Scalar {
    let m = field_modulus_bigint();
    let r = x.mod_floor(&m);
    let (_s, bytes) = r.to_bytes_be();
    Scalar::from(BigUint::from_bytes_be(&bytes))
}
fn fp_to_big(fp: &Scalar) -> BigInt {
    BigInt::from_bytes_be(Sign::Plus, &fp.into_bigint().to_bytes_be())
}
fn smt_compress(left: &BigInt, right: &BigInt) -> BigInt {
    fp_to_big(&poseidon2_compression(big_to_fp(left), big_to_fp(right)))
}
fn smt_leaf_hash(key: &BigInt, value: &BigInt) -> BigInt {
    fp_to_big(&poseidon2_hash2(
        big_to_fp(key),
        big_to_fp(value),
        Some(Scalar::from(1u64)),
    ))
}

#[derive(Default)]
struct SmtDb {
    data: HashMap<BigInt, Vec<BigInt>>,
    root: BigInt,
}

struct Smt {
    db: SmtDb,
    root: BigInt,
}

struct FindResult {
    found: bool,
    siblings: Vec<BigInt>,
    found_value: BigInt,
    not_found_key: BigInt,
    not_found_value: BigInt,
    is_old0: bool,
}

impl Smt {
    fn new() -> Self {
        Self {
            db: SmtDb {
                data: HashMap::new(),
                root: BigInt::from(0u32),
            },
            root: BigInt::from(0u32),
        }
    }
    fn split_bits(key: &BigInt) -> Vec<bool> {
        let mut bits = Vec::with_capacity(256);
        let mut k = key.clone();
        for _ in 0..256 {
            bits.push(k.bit(0));
            k = k.shr(1u32);
        }
        bits
    }
    fn find(&self, key: &BigInt) -> FindResult {
        let bits = Self::split_bits(key);
        self._find(key, &bits, &self.root, 0)
    }
    fn _find(&self, key: &BigInt, bits: &[bool], root: &BigInt, level: usize) -> FindResult {
        if *root == BigInt::from(0u32) {
            return FindResult {
                found: false,
                siblings: vec![],
                found_value: BigInt::from(0u32),
                not_found_key: key.clone(),
                not_found_value: BigInt::from(0u32),
                is_old0: true,
            };
        }
        let record = self.db.data.get(root).expect("node not found").clone();
        if record.len() == 3 && record[0] == BigInt::from(1u32) {
            if record[1] == *key {
                FindResult {
                    found: true,
                    siblings: vec![],
                    found_value: record[2].clone(),
                    not_found_key: BigInt::from(0u32),
                    not_found_value: BigInt::from(0u32),
                    is_old0: false,
                }
            } else {
                FindResult {
                    found: false,
                    siblings: vec![],
                    found_value: BigInt::from(0u32),
                    not_found_key: record[1].clone(),
                    not_found_value: record[2].clone(),
                    is_old0: false,
                }
            }
        } else if record.len() == 2 {
            let mut res = if !bits[level] {
                self._find(key, bits, &record[0], level + 1)
            } else {
                self._find(key, bits, &record[1], level + 1)
            };
            res.siblings.insert(
                0,
                if !bits[level] {
                    record[1].clone()
                } else {
                    record[0].clone()
                },
            );
            res
        } else {
            panic!("invalid record");
        }
    }
    fn insert(&mut self, key: &BigInt, value: &BigInt) {
        let new_key_bits = Self::split_bits(key);
        let res_find = self.find(key);
        assert!(!res_find.found, "key already exists");

        let mut siblings = res_find.siblings.clone();
        let mut mixed = false;
        let mut rt_old = BigInt::from(0u32);
        let mut added_one = false;

        if !res_find.is_old0 {
            let old_key_bits = Self::split_bits(&res_find.not_found_key);
            let mut i = siblings.len();
            while i < old_key_bits.len() && old_key_bits[i] == new_key_bits[i] {
                siblings.push(BigInt::from(0u32));
                i += 1;
            }
            rt_old = smt_leaf_hash(&res_find.not_found_key, &res_find.not_found_value);
            siblings.push(rt_old.clone());
            added_one = true;
        } else if !siblings.is_empty() {
            mixed = true;
        }

        let mut inserts: Vec<(BigInt, Vec<BigInt>)> = Vec::new();
        let mut rt = smt_leaf_hash(key, value);
        inserts.push((
            rt.clone(),
            vec![BigInt::from(1u32), key.clone(), value.clone()],
        ));

        for i in (0..siblings.len()).rev() {
            if i < siblings.len() - 1 && siblings[i] != BigInt::from(0u32) {
                mixed = true;
            }
            if mixed {
                let old_sibling = res_find.siblings[i].clone();
                if new_key_bits[i] {
                    rt_old = smt_compress(&old_sibling, &rt_old);
                } else {
                    rt_old = smt_compress(&rt_old, &old_sibling);
                }
            }
            let (new_rt, new_node) = if new_key_bits[i] {
                (
                    smt_compress(&siblings[i], &rt),
                    vec![siblings[i].clone(), rt.clone()],
                )
            } else {
                (
                    smt_compress(&rt, &siblings[i]),
                    vec![rt.clone(), siblings[i].clone()],
                )
            };
            inserts.push((new_rt.clone(), new_node));
            rt = new_rt;
        }

        if added_one {
            siblings.pop();
        }
        for (k, v) in inserts {
            self.db.data.insert(k, v);
        }
        self.db.root = rt.clone();
        self.root = rt;
    }
}

#[derive(Clone)]
struct SmtProof {
    siblings: Vec<BigInt>,
    not_found_key: BigInt,
    not_found_value: BigInt,
    is_old0: bool,
    root: BigInt,
}

fn prepare_smt_proof_with_overrides(
    key: &BigInt,
    overrides: &[(BigInt, BigInt)],
    max_levels: usize,
) -> SmtProof {
    let mut smt = Smt::new();
    for (k, v) in overrides {
        smt.insert(k, v);
    }
    let fr = smt.find(key);
    let mut siblings = fr.siblings.clone();
    while siblings.len() < max_levels {
        siblings.push(BigInt::from(0u32));
    }
    SmtProof {
        siblings,
        not_found_key: fr.not_found_key,
        not_found_value: fr.not_found_value,
        is_old0: fr.is_old0,
        root: smt.root.clone(),
    }
}


// ---------- Phase 2 scenario ----------

#[derive(Clone, Copy)]
struct Note {
    priv_key: Scalar,
    blinding: Scalar,
    amount: Scalar,
}
impl Note {
    fn new(p: u64, b: u64, a: u64) -> Self {
        Note { priv_key: Scalar::from(p), blinding: Scalar::from(b), amount: Scalar::from(a) }
    }
    fn pk(&self) -> Scalar { derive_public_key(self.priv_key) }
    fn commit(&self) -> Scalar { commitment(self.amount, self.pk(), self.blinding) }
    fn asp_leaf(&self) -> Scalar { poseidon2_hash2(self.pk(), Scalar::zero(), Some(Scalar::from(1u64))) }
}

const BLOCK_KEYS: [u64; 2] = [666, 777];
const MERCHANT: u64 = 0x00C0_FFEE;
const EXT_DOM: u64 = 5;

fn blocklist_overrides() -> Vec<(BigInt, BigInt)> {
    BLOCK_KEYS
        .iter()
        .map(|k| (BigInt::from(*k), BigInt::from(1u32)))
        .collect()
}

/// Build a circom input.json for the 2-in/2-out policy spend.
/// inputs[0] = dummy (amount 0, pool-membership gated off), inputs[1] = real note.
#[allow(clippy::too_many_arguments)]
fn build_input(
    out_path: &str,
    inputs: &[Note; 2],
    in_pool_indices: &[usize; 2],
    pool_leaves: &[Scalar],
    in_asp_indices: &[usize; 2],
    asp_leaves: &[Scalar],
    asp_membership_root: Scalar,
    payout: u64,
    merchant: Scalar,
) -> Result<()> {
    let pool_root = merkle_root(pool_leaves.to_vec());

    // per-input pool path + nullifier
    let mut in_path_indices = Vec::new();
    let mut in_path_elements: Vec<Vec<Scalar>> = Vec::new();
    let mut nullifiers = Vec::new();
    let mut commits = Vec::new();
    for i in 0..2 {
        let cm = inputs[i].commit();
        commits.push(cm);
        let (sib, pidx, _d) = merkle_proof(pool_leaves, in_pool_indices[i]);
        in_path_indices.push(Scalar::from(pidx));
        in_path_elements.push(sib);
        let sig = sign(inputs[i].priv_key, cm, Scalar::from(pidx));
        nullifiers.push(nullifier(cm, Scalar::from(pidx), sig));
    }

    // membership proofs (ASP allowlist) per input
    let mut mem_leaf = Vec::new();
    let mut mem_pidx = Vec::new();
    let mut mem_path: Vec<Vec<Scalar>> = Vec::new();
    for i in 0..2 {
        let leaf = inputs[i].asp_leaf();
        let (sib, pidx, _d) = merkle_proof(asp_leaves, in_asp_indices[i]);
        mem_leaf.push(leaf);
        mem_pidx.push(Scalar::from(pidx));
        mem_path.push(sib);
    }

    // non-membership (blocklist SMT) per input
    let overrides = blocklist_overrides();
    let mut nm_key = Vec::new();
    let mut nm_old_key = Vec::new();
    let mut nm_old_value = Vec::new();
    let mut nm_is_old0 = Vec::new();
    let mut nm_siblings: Vec<Vec<BigInt>> = Vec::new();
    let mut nm_root = Vec::new();
    for i in 0..2 {
        let key = scalar_to_bigint(inputs[i].pk());
        let proof = prepare_smt_proof_with_overrides(&key, &overrides, SMT_LEVELS);
        nm_key.push(key);
        if proof.is_old0 {
            nm_old_key.push(BigInt::from(0u32));
            nm_old_value.push(BigInt::from(0u32));
            nm_is_old0.push(BigInt::from(1u32));
        } else {
            nm_old_key.push(proof.not_found_key.clone());
            nm_old_value.push(proof.not_found_value.clone());
            nm_is_old0.push(BigInt::from(0u32));
        }
        nm_siblings.push(proof.siblings.clone());
        nm_root.push(proof.root.clone());
    }

    // outputs: two zero-notes (full withdrawal, no change)
    let out_commit = commitment(Scalar::zero(), Scalar::zero(), Scalar::zero());

    // public binding
    let field = field_modulus_bigint();
    let public_amount = &field - BigInt::from(payout); // -payout mod p
    let ext_data_hash = poseidon2_hash2(merchant, Scalar::from(payout), Some(Scalar::from(EXT_DOM)));

    let membership_proofs: Vec<serde_json::Value> = (0..2)
        .map(|i| json!([{
            "leaf": scalar_to_dec(mem_leaf[i]),
            "blinding": "0",
            "pathElements": mem_path[i].iter().map(|s| scalar_to_dec(*s)).collect::<Vec<_>>(),
            "pathIndices": scalar_to_dec(mem_pidx[i]),
        }]))
        .collect();
    let non_membership_proofs: Vec<serde_json::Value> = (0..2)
        .map(|i| json!([{
            "key": bigint_to_dec(&nm_key[i]),
            "siblings": nm_siblings[i].iter().map(bigint_to_dec).collect::<Vec<_>>(),
            "oldKey": bigint_to_dec(&nm_old_key[i]),
            "oldValue": bigint_to_dec(&nm_old_value[i]),
            "isOld0": bigint_to_dec(&nm_is_old0[i]),
        }]))
        .collect();

    let input = json!({
        "root": scalar_to_dec(pool_root),
        "publicAmount": bigint_to_dec(&public_amount),
        "extDataHash": scalar_to_dec(ext_data_hash),
        "inputNullifier": nullifiers.iter().map(|s| scalar_to_dec(*s)).collect::<Vec<_>>(),
        "outputCommitment": vec![scalar_to_dec(out_commit), scalar_to_dec(out_commit)],
        "membershipRoots": vec![vec![scalar_to_dec(asp_membership_root)], vec![scalar_to_dec(asp_membership_root)]],
        "nonMembershipRoots": (0..2).map(|i| vec![bigint_to_dec(&nm_root[i])]).collect::<Vec<_>>(),
        "membershipProofs": membership_proofs,
        "nonMembershipProofs": non_membership_proofs,
        "inAmount": inputs.iter().map(|n| scalar_to_dec(n.amount)).collect::<Vec<_>>(),
        "inPrivateKey": inputs.iter().map(|n| scalar_to_dec(n.priv_key)).collect::<Vec<_>>(),
        "inBlinding": inputs.iter().map(|n| scalar_to_dec(n.blinding)).collect::<Vec<_>>(),
        "inPathIndices": in_path_indices.iter().map(|s| scalar_to_dec(*s)).collect::<Vec<_>>(),
        "inPathElements": in_path_elements.iter().map(|v| v.iter().map(|s| scalar_to_dec(*s)).collect::<Vec<_>>()).collect::<Vec<_>>(),
        "outAmount": vec!["0","0"],
        "outPubkey": vec!["0","0"],
        "outBlinding": vec!["0","0"],
    });
    std::fs::write(out_path, serde_json::to_string_pretty(&input)?)?;
    Ok(())
}


fn note_nullifier(note: &Note, pool_leaves: &[Scalar], pool_index: usize) -> Scalar {
    let cm = note.commit();
    let (_s, pidx, _d) = merkle_proof(pool_leaves, pool_index);
    let sig = sign(note.priv_key, cm, Scalar::from(pidx));
    nullifier(cm, Scalar::from(pidx), sig)
}

fn main() -> Result<()> {
    let out_dir = std::env::args().nth(1).unwrap_or_else(|| ".".into());

    // sanity: XLM zero-leaf must match the contracts' get_zeroes[0]
    let z0 = xlm_zero().into_bigint().to_bytes_be();
    let expected: [u8; 32] = [
        37, 48, 34, 136, 219, 153, 53, 3, 68, 151, 65, 131, 206, 49, 13, 99, 181, 58, 187, 158,
        240, 248, 87, 87, 83, 238, 211, 110, 1, 24, 249, 206,
    ];
    assert_eq!(z0.as_slice(), &expected, "xlm_zero != get_zeroes[0] — param mismatch!");
    eprintln!("[wgen] xlm_zero matches contract get_zeroes[0] ✓");

    // 3 deposit notes (fixed denominations) at pool indices 0,1,2.
    let note_a = Note::new(1001, 2001, 1);   // not allowlisted -> used for badasp
    let note_b = Note::new(1002, 2002, 5);   // spend #1
    let note_c = Note::new(1003, 2003, 10);  // spend #2 (distinct)
    let dummy = Note::new(9001, 9002, 0);    // canonical inert dummy (slot 0), reused every spend
    let merchant = Scalar::from(MERCHANT);

    let pool_leaves = build_full_tree(LEVELS, &[
        (0, note_a.commit()),
        (1, note_b.commit()),
        (2, note_c.commit()),
    ]);
    let pool_root = merkle_root(pool_leaves.clone());

    // Official ASP allowlist = {dummy(0), B(1), C(2)} so BOTH B and C are spendable.
    let asp_official = build_full_tree(LEVELS, &[
        (0, dummy.asp_leaf()),
        (1, note_b.asp_leaf()),
        (2, note_c.asp_leaf()),
    ]);
    let official_root = merkle_root(asp_official.clone());
    // Fake ASP (mismatch test): extra leaf -> different root, B still a member.
    let asp_fake = build_full_tree(LEVELS, &[
        (0, dummy.asp_leaf()),
        (1, note_b.asp_leaf()),
        (2, note_c.asp_leaf()),
        (3, Scalar::from(424242u64)),
    ]);
    let fake_root = merkle_root(asp_fake.clone());

    // spend #1: B at pool idx 1, asp idx 1, payout 5
    build_input(&format!("{out_dir}/input_spendB.json"), &[dummy, note_b], &[0, 1], &pool_leaves, &[0, 1], &asp_official, official_root, 5, merchant)?;
    // spend #2: C at pool idx 2, asp idx 2, payout 10
    build_input(&format!("{out_dir}/input_spendC.json"), &[dummy, note_c], &[0, 2], &pool_leaves, &[0, 2], &asp_official, official_root, 10, merchant)?;
    // mismatch: B against the fake ASP root (valid proof, wrong root)
    build_input(&format!("{out_dir}/input_mismatch.json"), &[dummy, note_b], &[0, 1], &pool_leaves, &[0, 1], &asp_fake, fake_root, 5, merchant)?;
    // badasp: note A (NOT allowlisted) — claim membership at empty index 3 -> witness fails
    build_input(&format!("{out_dir}/input_badasp.json"), &[dummy, note_a], &[0, 0], &pool_leaves, &[0, 3], &asp_official, official_root, 1, merchant)?;

    let bl_root = prepare_smt_proof_with_overrides(&scalar_to_bigint(note_b.pk()), &blocklist_overrides(), SMT_LEVELS).root;
    let field = field_modulus_bigint();
    let out_commit = commitment(Scalar::zero(), Scalar::zero(), Scalar::zero());
    let dummy_null = note_nullifier(&dummy, &pool_leaves, 0);

    let spend_params = |real: &Note, real_pool_idx: usize, payout: u64| {
        let pa = &field - BigInt::from(payout);
        let edh = poseidon2_hash2(merchant, Scalar::from(payout), Some(Scalar::from(EXT_DOM)));
        let nr = note_nullifier(real, &pool_leaves, real_pool_idx);
        json!({
            "payout": payout,
            "public_amount": bigint_to_dec(&pa),
            "ext_data_hash": scalar_to_dec(edh),
            "input_nullifiers": [scalar_to_dec(dummy_null), scalar_to_dec(nr)],
            "output_commitments": [scalar_to_dec(out_commit), scalar_to_dec(out_commit)],
            "asp_membership_root": scalar_to_dec(official_root),
            "asp_non_membership_root": bigint_to_dec(&bl_root),
            "root": scalar_to_dec(pool_root),
            "merchant": scalar_to_dec(merchant),
        })
    };

    let scenario = json!({
        "deposits": [
            {"amount": 1u32, "commitment": scalar_to_dec(note_a.commit())},
            {"amount": 5u32, "commitment": scalar_to_dec(note_b.commit())},
            {"amount": 10u32, "commitment": scalar_to_dec(note_c.commit())},
        ],
        "asp_leaves": [scalar_to_dec(dummy.asp_leaf()), scalar_to_dec(note_b.asp_leaf()), scalar_to_dec(note_c.asp_leaf())],
        "official_asp_root": scalar_to_dec(official_root),
        "fake_asp_root": scalar_to_dec(fake_root),
        "blocklist_root": bigint_to_dec(&bl_root),
        "pool_root": scalar_to_dec(pool_root),
        "merchant": scalar_to_dec(merchant),
        "dummy_nullifier": scalar_to_dec(dummy_null),
        "spendB": spend_params(&note_b, 1, 5),
        "spendC": spend_params(&note_c, 2, 10),
    });
    std::fs::write(format!("{out_dir}/scenario.json"), serde_json::to_string_pretty(&scenario)?)?;
    eprintln!("[wgen] dummy_nullifier  = {}", scalar_to_dec(dummy_null));
    eprintln!("[wgen] official_asp_root= {}", scalar_to_dec(official_root));
    eprintln!("[wgen] spendB null[1]   = {}", scalar_to_dec(note_nullifier(&note_b, &pool_leaves, 1)));
    eprintln!("[wgen] spendC null[1]   = {}", scalar_to_dec(note_nullifier(&note_c, &pool_leaves, 2)));
    Ok(())
}
