#!/usr/bin/env bash
# Deploy Cowrie contracts to a Stellar network.
# Mirrors the reference deploy flow: embed the circuit verification key into the
# verifier, build+deploy verifier, asp, pool (wired together), init constructors,
# and write deployments/<network>.json.
#
# Usage: ./scripts/deploy.sh <network> --deployer <identity> [--asp-levels N]
#        [--pool-levels N] [--max-deposit U] --vk-file <verification_key.json>
#
# STUB — see PLAN.md Phase 3/7. Requires: stellar CLI, wasm32v1-none target.
set -euo pipefail
NETWORK="${1:-testnet}"
echo "TODO(PLAN Phase 3/7): deploy Cowrie to ${NETWORK}"
echo "  1. cd contracts && stellar contract build   # -> target/wasm32v1-none/release/*.wasm"
echo "  2. stellar contract deploy cowrie_verifier.wasm  (VK embedded at build time)"
echo "  3. stellar contract deploy cowrie_asp.wasm"
echo "  4. stellar contract deploy cowrie_pool.wasm --  __constructor (token, verifier, asp, ...)"
echo "  5. write deployments/${NETWORK}.json"
echo "stellar: $(stellar --version 2>/dev/null | head -1 || echo 'NOT INSTALLED')"
