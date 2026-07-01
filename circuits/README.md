# Cowrie Circuits

Circom circuits forked from Nethermind privacy-pools. See [STUDY.md](../STUDY.md) §1.

- `src/policyTransaction.circom` — main 2-in/2-out JoinSplit + ASP clean-funds policy (stub).
- `scripts/compile.sh` — `circom` → R1CS + WASM witness generator.
- `scripts/setup.sh` — snarkjs Groth16 trusted setup → `circuit_final.zkey` + `verification_key.json`.

Build artifacts (`build/`, `*.zkey`, `*.ptau`) are git-ignored. The `.wasm` + `.zkey` are
served to the browser for snarkjs proving (see `/web`); `verification_key.json` is embedded
into the on-chain verifier (see `/contracts/verifier`).

Install: `npm install` (pulls circomlib + snarkjs). Requires `circom` on PATH.
