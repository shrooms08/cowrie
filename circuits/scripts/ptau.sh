#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
P=build/ptau
echo "[ptau] DEV-ONLY powers of tau, throwaway entropy — NOT for production"
snarkjs powersoftau new bn128 16 "$P/pot16_0000.ptau" -v
snarkjs powersoftau contribute "$P/pot16_0000.ptau" "$P/pot16_0001.ptau" --name="cowrie-dev-1" -v -e="dev-only entropy $(date +%s)"
snarkjs powersoftau prepare phase2 "$P/pot16_0001.ptau" "$P/pot16_final.ptau" -v
echo "[ptau] done: $P/pot16_final.ptau"
