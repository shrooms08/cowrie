#!/usr/bin/env bash
# Phase R2-0 — deploy THROWAWAY USDC-rail contracts. Reuses the unchanged Groth16
# verifier. Fresh ASP (dummy leaf + blocklist root) and the throwaway USDC pool
# wired to the real testnet USDC SAC. DOES NOT touch the live demo pool/config.
set -euo pipefail
cd /Users/minos/Projects/cowrie

NET=testnet
SRC=killswitch
VERIFIER=CCKJHEGDDCBYYZFNK5W2Q7G2FAR7ASMQGYOOTXZOMSAEI6O37WEVK65T
USDC=CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA
DUMMY_ASP_LEAF=19187717433344121899528298946775778525835347177217043402537944412944308483581
DUMMY_NULLIFIER=18840403724275375087806719211480066574406617902219092288312412124610213555779
BLOCKLIST_ROOT=6028266247113828394766328778505083860001642501208832388342836319917635960533
ADMIN=$(stellar keys public-key $SRC)

ASP_WASM=contracts/target/wasm32v1-none/release/cowrie_asp.optimized.wasm
POOL_WASM=contracts/target/wasm32v1-none/release/cowrie_pool_usdc.wasm

retry() { for i in 1 2 3 4 5; do OUT=$("$@" 2>&1) && { echo "$OUT"; return 0; }; echo "  retry $i: $(echo "$OUT"|tail -1)" >&2; sleep 6; done; echo "FAILED: $*" >&2; return 1; }

echo ">> deploy ASP"
ASP=$(stellar contract deploy --wasm $ASP_WASM --source $SRC --network $NET -- --admin $ADMIN 2>/dev/null | tail -1)
echo "ASP=$ASP"
sleep 3
retry stellar contract invoke --id $ASP --source $SRC --network $NET -- set_blocklist_root --root $BLOCKLIST_ROOT >/dev/null
sleep 3
retry stellar contract invoke --id $ASP --source $SRC --network $NET -- admin_add --leaf $DUMMY_ASP_LEAF | tail -1
sleep 3
echo ">> deploy USDC pool (verifier+asp+dummy+usdc)"
POOL=$(stellar contract deploy --wasm $POOL_WASM --source $SRC --network $NET -- \
  --verifier $VERIFIER --asp $ASP --dummy_nullifier $DUMMY_NULLIFIER --usdc $USDC 2>/dev/null | tail -1)
echo "POOL=$POOL"
echo "$ASP" > /tmp/r2_asp.txt
echo "$POOL" > /tmp/r2_pool.txt
echo "R2_FRESH ASP=$ASP POOL=$POOL"
