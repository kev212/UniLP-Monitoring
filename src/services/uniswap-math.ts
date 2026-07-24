const Q96 = 1n << 96n;
const MAX_UINT256 = (1n << 256n) - 1n;
const MAX_TICK = 887_272;

const TICK_MULTIPLIERS = [
  0xfffcb933bd6fad37aa2d162d1a594001n,
  0xfff97272373d413259a46990580e213an,
  0xfff2e50f5f656932ef12357cf3c7fdccn,
  0xffe5caca7e10e4e61c3624eaa0941cd0n,
  0xffcb9843d60f6159c9db58835c926644n,
  0xff973b41fa98c081472e6896dfb254c0n,
  0xff2ea16466c96a3843ec78b326b52861n,
  0xfe5dee046a99a2a811c461f1969c3053n,
  0xfcbe86c7900a88aedcffc83b479aa3a4n,
  0xf987a7253ac413176f2b074cf7815e54n,
  0xf3392b0822b70005940c7a398e4b70f3n,
  0xe7159475a2c29b7443b29c7fa6e889d9n,
  0xd097f3bdfd2022b8845ad8f792aa5825n,
  0xa9f746462d870fdf8a65dc1f90e061e5n,
  0x70d869a156d2a1b890bb3df62baf32f7n,
  0x31be135f97d08fd981231505542fcfa6n,
  0x9aa508b5b7a84e1c677de54f3e99bc9n,
  0x5d6af8dedb81196699c329225ee604n,
  0x2216e584f5fa1ea926041bedfe98n,
  0x48a170391f7dc42444e8fa2n,
] as const;

export function sqrtRatioAtTick(tick: number): bigint {
  if (!Number.isInteger(tick) || tick < -MAX_TICK || tick > MAX_TICK) {
    throw new Error(`Tick ${tick} is outside the supported range`);
  }
  const absoluteTick = Math.abs(tick);
  let ratio = absoluteTick & 1 ? TICK_MULTIPLIERS[0] : 1n << 128n;
  for (let bit = 1; bit < TICK_MULTIPLIERS.length; bit += 1) {
    if (absoluteTick & (1 << bit)) ratio = (ratio * TICK_MULTIPLIERS[bit]!) >> 128n;
  }
  if (tick > 0) ratio = MAX_UINT256 / ratio;
  return (ratio >> 32n) + ((ratio & ((1n << 32n) - 1n)) === 0n ? 0n : 1n);
}

export function amountsForLiquidity(sqrtPriceX96: bigint, tickLower: number, tickUpper: number, liquidity: bigint): { amount0: bigint; amount1: bigint } {
  const sqrtLower = sqrtRatioAtTick(tickLower);
  const sqrtUpper = sqrtRatioAtTick(tickUpper);
  if (sqrtPriceX96 <= sqrtLower) {
    return { amount0: amount0Delta(sqrtLower, sqrtUpper, liquidity), amount1: 0n };
  }
  if (sqrtPriceX96 < sqrtUpper) {
    return {
      amount0: amount0Delta(sqrtPriceX96, sqrtUpper, liquidity),
      amount1: amount1Delta(sqrtLower, sqrtPriceX96, liquidity),
    };
  }
  return { amount0: 0n, amount1: amount1Delta(sqrtLower, sqrtUpper, liquidity) };
}

export function applySlippage(amount: bigint, slippageBps: number): bigint {
  return (amount * BigInt(10_000 - slippageBps)) / 10_000n;
}

function amount0Delta(sqrtA: bigint, sqrtB: bigint, liquidity: bigint): bigint {
  const numerator = (liquidity << 96n) * (sqrtB - sqrtA);
  return (numerator / sqrtB) / sqrtA;
}

function amount1Delta(sqrtA: bigint, sqrtB: bigint, liquidity: bigint): bigint {
  return (liquidity * (sqrtB - sqrtA)) / Q96;
}

export function liquidityForAmount0(sqrtLower: bigint, sqrtUpper: bigint, amount0: bigint): bigint {
  const intermediate = (amount0 * sqrtUpper * sqrtLower) / (sqrtUpper - sqrtLower);
  return intermediate / Q96;
}

export function liquidityForAmount1(sqrtLower: bigint, sqrtUpper: bigint, amount1: bigint): bigint {
  return (amount1 * Q96) / (sqrtUpper - sqrtLower);
}

export function tickToFloorSpacing(tick: number, tickSpacing: number): number {
  return Math.floor(tick / tickSpacing) * tickSpacing;
}

export function tickToCeilSpacing(tick: number, tickSpacing: number): number {
  return Math.ceil(tick / tickSpacing) * tickSpacing;
}

export function ticksForDropPercent(dropPercent: number): number {
  const ratio = 1 / (1 - dropPercent / 100);
  return Math.round(Math.log(ratio) / Math.log(1.0001));
}
