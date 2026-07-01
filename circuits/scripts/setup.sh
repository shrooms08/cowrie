#!/usr/bin/env bash
# DEV-ONLY Groth16 trusted setup for Cowrie's policy_tx_2_2 circuit.
#
# !!! DEV ONLY — single-contributor, throwaway entropy. NOT a real ceremony.
#     Do NOT use these keys for production. Re-run a multi-party ceremony before
#     mainnet (see PLAN.md cross-cutting / Phase 7).
#
# Produces:
#   build/ptau/pot16_final.ptau   (powers of tau, bn128, 2^16)
#   build/keys/policy_final.zkey  (Groth16 proving key)
#   build/keys/verification_key.json  (embedded into the verifier contract)
set -euo pipefail
cd "$(dirname "$0")/.."
R1CS=build/policy_tx_2_2.r1cs
P=build/ptau
mkdir -p "$P" build/keys

# 37,616 constraints -> domain 2^16. Power 16 is the minimum that fits.
if [ ! -f "$P/pot16_final.ptau" ]; then
  echo "[setup] DEV-ONLY powers of tau (bn128, 2^16)…"
  snarkjs powersoftau new bn128 16 "$P/pot16_0000.ptau" -v
  snarkjs powersoftau contribute "$P/pot16_0000.ptau" "$P/pot16_0001.ptau" \
    --name="cowrie-dev-1" -v -e="dev-only entropy $(date +%s%N)"
  snarkjs powersoftau prepare phase2 "$P/pot16_0001.ptau" "$P/pot16_final.ptau" -v
fi

echo "[setup] DEV-ONLY Groth16 phase-2…"
snarkjs groth16 setup "$R1CS" "$P/pot16_final.ptau" build/keys/policy_0000.zkey
snarkjs zkey contribute build/keys/policy_0000.zkey build/keys/policy_final.zkey \
  --name="cowrie-dev-phase2" -e="dev-only $(date +%s%N)"
snarkjs zkey export verificationkey build/keys/policy_final.zkey build/keys/verification_key.json
echo "[setup] done -> build/keys/{policy_final.zkey,verification_key.json}"
