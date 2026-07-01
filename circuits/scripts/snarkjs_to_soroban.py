#!/usr/bin/env python3
"""Convert snarkjs proof.json + public.json into Soroban byte layouts.

Proven layout (Cowrie Phase 0/0b):
  G1: x(32 BE) || y(32 BE)
  G2: x.c1 || x.c0 || y.c1 || y.c0  (imaginary first), 32B BE each
  public inputs: 32B big-endian each, plain integers (not Montgomery)
Outputs hex strings for proof (256B) and concatenated public inputs (n*32B).
"""
import json, sys

def b32(v):
    return int(v).to_bytes(32, "big")

def main():
    proof = json.load(open(sys.argv[1]))
    public = json.load(open(sys.argv[2]))
    a = proof["pi_a"]; b = proof["pi_b"]; c = proof["pi_c"]
    proof_bytes = b""
    # A (G1)
    proof_bytes += b32(a[0]) + b32(a[1])
    # B (G2): x.c1, x.c0, y.c1, y.c0   (snarkjs stores [c0, c1])
    proof_bytes += b32(b[0][1]) + b32(b[0][0]) + b32(b[1][1]) + b32(b[1][0])
    # C (G1)
    proof_bytes += b32(c[0]) + b32(c[1])
    assert len(proof_bytes) == 256, len(proof_bytes)
    pub_bytes = b"".join(b32(x) for x in public)
    out = {
        "proof_hex": proof_bytes.hex(),
        "public_hex": pub_bytes.hex(),
        "n_public": len(public),
    }
    print(json.dumps(out))

if __name__ == "__main__":
    main()
