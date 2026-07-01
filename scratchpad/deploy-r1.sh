#!/usr/bin/env bash
# Deploy fresh canonical change-enabled contracts for Phase R1 (Pay UI).
# Reuses the unchanged Groth16 verifier CCKJHEGD. Fresh ASP (seeded dummy leaf +
# blocklist root) and fresh change-enabled pool wired to verifier+asp+dummy_null.
set -euo pipefail
cd /Users/minos/Projects/cowrie

NET=testnet
SRC=killswitch
VERIFIER=CCKJHEGDDCBYYZFNK5W2Q7G2FAR7ASMQGYOOTXZOMSAEI6O37WEVK65T
DUMMY_ASP_LEAF=19187717433344121899528298946775778525835347177217043402537944412944308483581
DUMMY_NULLIFIER=18840403724275375087806719211480066574406617902219092288312412124610213555779
BLOCKLIST_ROOT=6028266247113828394766328778505083860001642501208832388342836319917635960533
ADMIN=$(stellar keys public-key $SRC)

POOL_WASM=contracts/target/wasm32v1-none/release/cowrie_pool.optimized.wasm
ASP_WASM=contracts/target/wasm32v1-none/release/cowrie_asp.optimized.wasm

echo ">> deploy ASP (admin=$ADMIN)"
ASP=$(stellar contract deploy --wasm $ASP_WASM --source $SRC --network $NET -- --admin $ADMIN 2>/dev/null | tail -1)
echo "ASP=$ASP"

echo ">> set_blocklist_root"
stellar contract invoke --id $ASP --source $SRC --network $NET -- set_blocklist_root --root $BLOCKLIST_ROOT >/dev/null
echo ">> admin_add dummy_asp_leaf (index 0)"
stellar contract invoke --id $ASP --source $SRC --network $NET -- admin_add --leaf $DUMMY_ASP_LEAF
echo ">> deploy POOL (verifier=$VERIFIER asp=$ASP)"
POOL=$(stellar contract deploy --wasm $POOL_WASM --source $SRC --network $NET -- \
  --verifier $VERIFIER --asp $ASP --dummy_nullifier $DUMMY_NULLIFIER 2>/dev/null | tail -1)
echo "POOL=$POOL"

echo "FRESH_R1 ASP=$ASP POOL=$POOL"
echo "$ASP" > /tmp/r1_asp.txt
echo "$POOL" > /tmp/r1_pool.txt
