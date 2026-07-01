#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
PTAU=build/ptau/pot16_final.ptau
R1CS=build/policy_tx_2_2.r1cs
mkdir -p build/keys
echo "[setup] DEV-ONLY Groth16 phase-2 (single-contributor, throwaway entropy) — NOT for production"
snarkjs groth16 setup "$R1CS" "$PTAU" build/keys/policy_0000.zkey
snarkjs zkey contribute build/keys/policy_0000.zkey build/keys/policy_final.zkey \
  --name="cowrie-dev-phase2" -e="dev-only $(date +%s%N)"
snarkjs zkey export verificationkey build/keys/policy_final.zkey build/keys/verification_key.json
echo "[setup] done"
