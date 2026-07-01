#!/usr/bin/env bash
# Cowrie Phase 2 end-to-end (headless): deposit -> allowlist -> TWO distinct spends
# (proving the dummy-nullifier fix) -> real double-spend rejection.
# Assumes verifier/asp/pool are deployed (see deployments/testnet/phase2.json) and
# the circuit artifacts exist.
#
# Prereqs: circuits/build/keys/{policy_final.zkey,verification_key.json};
#          scratchpad/zk/target/release/wgen; stellar identity `killswitch` funded.
# Usage: VERIFIER=C... ASP=C... POOL=C... bash scripts/e2e_phase2.sh
set -euo pipefail
cd "$(dirname "$0")/.."
NET=testnet; SRC=killswitch; P2=circuits/build/p2b
get(){ python3 -c "import json;print(json.load(open('$P2/scenario.json'))$1)"; }
# retry an invoke past transient testnet RPC flakes
run(){ for a in 1 2 3 4 5; do O=$(stellar contract invoke --id "$1" --source $SRC --network $NET "${@:2}" 2>&1); \
  echo "$O" | grep -qiE 'SendRequest|client error|TxBadSeq|Connect' || { echo "$O"; return 0; }; sleep 4; done; echo "$O"; }

echo "== 1. scenario + proofs (B, C, mismatch) =="
mkdir -p "$P2"; scratchpad/zk/target/release/wgen "$P2"
for m in spendB spendC; do
  node circuits/build/policy_tx_2_2_js/generate_witness.js \
    circuits/build/policy_tx_2_2_js/policy_tx_2_2.wasm "$P2/input_$m.json" "$P2/$m.wtns"
  snarkjs groth16 prove circuits/build/keys/policy_final.zkey "$P2/$m.wtns" "$P2/proof_$m.json" "$P2/public_$m.json"
  python3 circuits/scripts/snarkjs_to_soroban.py "$P2/proof_$m.json" "$P2/public_$m.json" > "$P2/soroban_$m.json"
done

echo "== 2. deposit A,B,C =="
for i in 0 1 2; do
  run "$POOL" -- deposit --amount "$(get "['deposits'][$i]['amount']")" --commitment "$(get "['deposits'][$i]['commitment']")" >/dev/null
done

echo "== 3. allowlist dummy,B,C + blocklist =="
for i in 0 1 2; do run "$ASP" -- admin_add --leaf "$(get "['asp_leaves'][$i]")" >/dev/null; done
run "$ASP" -- set_blocklist_root --root "$(get "['blocklist_root']")" >/dev/null

spend(){ # $1=spendkey(spendB/spendC) $2=send
  local k=$1 PH; PH=$(python3 -c "import json;print(json.load(open('$P2/soroban_$k.json'))['proof_hex'])")
  run "$POOL" --send="$2" -- spend --proof "$PH" \
    --root "$(get "['$k']['root']")" --public_amount "$(get "['$k']['public_amount']")" \
    --ext_data_hash "$(get "['$k']['ext_data_hash']")" \
    --input_nullifiers "[\"$(get "['$k']['input_nullifiers'][0]")\",\"$(get "['$k']['input_nullifiers'][1]")\"]" \
    --output_commitments "[\"$(get "['$k']['output_commitments'][0]")\",\"$(get "['$k']['output_commitments'][1]")\"]" \
    --asp_membership_root "$(get "['$k']['asp_membership_root']")" \
    --asp_non_membership_root "$(get "['$k']['asp_non_membership_root']")" \
    --merchant "$(get "['$k']['merchant']")" --payout "$(get "['$k']['payout']")"
}

echo "== 4. spend B (payout 5) -> success =="
spend spendB yes | grep -qi SpendEvent && echo "   B SUCCESS ✓"
echo "== 5. spend C (payout 10) — SAME dummy nullifier as B -> success =="
spend spendC yes | grep -qi SpendEvent && echo "   C SUCCESS ✓ (dummy no longer blocks distinct spends)"
echo "== 6. re-spend B (real double-spend) -> Error #6 =="
spend spendB no | grep -q '#6' && echo "   rejected #6 AlreadySpent ✓"
echo "== e2e complete =="
