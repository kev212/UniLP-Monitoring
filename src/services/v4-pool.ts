import { encodeAbiParameters, keccak256, zeroAddress, type Address, type Hex } from "viem";

export const DYNAMIC_FEE_FLAG = 0x80_0000;

export interface V4PoolKey {
  currency0: Address;
  currency1: Address;
  fee: number;
  tickSpacing: number;
  hooks: Address;
}

export function v4PoolId(poolKey: V4PoolKey): Hex {
  return keccak256(encodeAbiParameters(
    [
      { type: "address" },
      { type: "address" },
      { type: "uint24" },
      { type: "int24" },
      { type: "address" },
    ],
    [poolKey.currency0, poolKey.currency1, poolKey.fee, poolKey.tickSpacing, poolKey.hooks],
  ));
}

export function isDynamicFee(fee: number): boolean {
  return fee === DYNAMIC_FEE_FLAG;
}

export function hasV4Hooks(hooks: Address): boolean {
  return hooks.toLowerCase() !== zeroAddress;
}
