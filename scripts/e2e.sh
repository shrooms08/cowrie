#!/usr/bin/env bash
# End-to-end smoke test of the full Cowrie flow.
# STUB — see PLAN.md Phase 7.
set -euo pipefail
echo "TODO(PLAN Phase 7) e2e:"
echo "  1. compile circuits + trusted setup (circuits/scripts/{compile,setup}.sh)"
echo "  2. deploy contracts (scripts/deploy.sh testnet ...)"
echo "  3. start mock-anchor"
echo "  4. deposit USDC -> prove (snarkjs) -> transact -> merchant pay -> anchor settle"
echo "  5. assert balance hidden, nullifier spent, payout recorded"
