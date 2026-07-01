#!/usr/bin/env python3
"""Emit a self-contained Rust `vk.rs` (Soroban byte layout) from a snarkjs
verification_key.json.  G1 = x(32BE)||y(32BE); G2 = x.c1||x.c0||y.c1||y.c0."""
import json, sys

def b32(v): return int(v).to_bytes(32, "big")
def g1(p): return b32(p[0]) + b32(p[1])
def g2(p): return b32(p[0][1]) + b32(p[0][0]) + b32(p[1][1]) + b32(p[1][0])
def arr(b): return "[" + ",".join(f"0x{x:02x}" for x in b) + "]"

v = json.load(open(sys.argv[1]))
ic = v["IC"]
out = []
out.append("// Auto-generated from verification_key.json — DO NOT EDIT.")
out.append("// DEV-ONLY trusted setup. Regenerate + redeploy for production.")
out.append(f"pub const VK_ALPHA_G1: [u8; 64] = {arr(g1(v['vk_alpha_1']))};")
out.append(f"pub const VK_BETA_G2: [u8; 128] = {arr(g2(v['vk_beta_2']))};")
out.append(f"pub const VK_GAMMA_G2: [u8; 128] = {arr(g2(v['vk_gamma_2']))};")
out.append(f"pub const VK_DELTA_G2: [u8; 128] = {arr(g2(v['vk_delta_2']))};")
out.append(f"pub const VK_IC: [[u8; 64]; {len(ic)}] = [")
for p in ic:
    out.append(f"    {arr(g1(p))},")
out.append("];")
sys.stdout.write("\n".join(out) + "\n")
