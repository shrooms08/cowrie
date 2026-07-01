declare module "snarkjs" {
  export const groth16: {
    prove(
      zkey: Uint8Array,
      wtns: Uint8Array
    ): Promise<{ proof: { pi_a: string[]; pi_b: string[][]; pi_c: string[] }; publicSignals: string[] }>;
    verify(vk: unknown, publicSignals: string[], proof: unknown): Promise<boolean>;
  };
  export const wtns: unknown;
}
