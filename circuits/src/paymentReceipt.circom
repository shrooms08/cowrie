pragma circom 2.2.2;

// Cowrie payment-receipt (selective disclosure) circuit — Claim A.
//
// Proves, to ONE chosen recipient R, that the prover is the payer behind a
// specific past on-chain SpendEvent, revealing nothing else:
//   (a) knowledge of the secret preimage (privateKey, blinding, pathIndices)
//       that produces the PUBLISHED nullifier of that payment — i.e. "I am the
//       payer", AND that the payment's `amount` is exactly the public amount
//       (amount is folded into the commitment -> nullifier, so a wrong amount
//       can't reproduce the nullifier);
//   (b) binds the receipt to a PUBLIC recipient identifier `recipient` (R) so a
//       receipt handed to R is NOT replayable by R to a third party R' — every
//       public input is bound by Groth16, so changing R breaks verification;
//   (c) re-states the public `merchant` so the receipt asserts "I paid THIS
//       amount to THIS merchant" (merchant is not in the nullifier preimage, so
//       it is bound to the proof's public vector and cross-checked on-chain by R
//       against the SpendEvent).
//
// Reuses the EXACT note domains from policyTransaction.circom so the recomputed
// nullifier equals the one the spend published.

include "./keypair.circom";
include "./poseidon2/poseidon2_hash.circom";

template PaymentReceipt() {
    /** PUBLIC **/
    signal input nullifier;   // the SpendEvent nullifier being disclosed
    signal input amount;      // the SpendEvent payout (bound via the commitment)
    signal input merchant;    // the SpendEvent merchant id (re-stated)
    signal input recipient;   // R — the single party this receipt is disclosed to

    /** PRIVATE (payer secrets for the spent note) **/
    signal input privateKey;
    signal input blinding;
    signal input pathIndices;

    // pubkey = H(privateKey, 0, dom=3)
    component keypair = Keypair();
    keypair.privateKey <== privateKey;

    // commitment = H(amount, pubkey, blinding, dom=1)  — folds the PUBLIC amount
    component commitmentHasher = Poseidon2(3);
    commitmentHasher.inputs[0] <== amount;
    commitmentHasher.inputs[1] <== keypair.publicKey;
    commitmentHasher.inputs[2] <== blinding;
    commitmentHasher.domainSeparation <== 0x01;

    // signature = H(privateKey, commitment, pathIndices, dom=4)
    component sig = Signature();
    sig.privateKey <== privateKey;
    sig.commitment <== commitmentHasher.out;
    sig.merklePath <== pathIndices;

    // nullifier = H(commitment, pathIndices, signature, dom=2)
    component nullifierHasher = Poseidon2(3);
    nullifierHasher.inputs[0] <== commitmentHasher.out;
    nullifierHasher.inputs[1] <== pathIndices;
    nullifierHasher.inputs[2] <== sig.out;
    nullifierHasher.domainSeparation <== 0x02;

    // "I am the payer of this exact nullifier (and amount)."
    nullifierHasher.out === nullifier;

    // Make recipient + merchant load-bearing public inputs (forced into the
    // R1CS so they cannot be stripped; their IC points are real). Groth16 then
    // binds the proof to the exact (nullifier, amount, merchant, recipient).
    signal recipientSquare;
    recipientSquare <== recipient * recipient;
    signal merchantSquare;
    merchantSquare <== merchant * merchant;
}

component main {public [nullifier, amount, merchant, recipient]} = PaymentReceipt();
