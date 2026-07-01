#!/usr/bin/env bash
# Compile Cowrie's policy_tx_2_2 circuit to R1CS + WASM witness generator + SYM.
# Requires: circom (>=2.2). circomlib is vendored at src/circomlib (locked rev).
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p build
echo "circom: $(circom --version)"
circom src/policy_tx_2_2.circom --r1cs --wasm --sym -o build -l src
echo "--- r1cs info ---"
snarkjs r1cs info build/policy_tx_2_2.r1cs
