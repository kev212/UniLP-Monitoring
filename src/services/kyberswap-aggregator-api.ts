import { decodeFunctionData, isAddress, isHex, parseAbi, zeroAddress, type Address, type Hex } from "viem";

import type { PositionRecord, TransactionPlan } from "../types.js";

const API_URL = "https://aggregator-api.kyberswap.com";
const KYBER_ROUTER = "0x6131B5fae19EA4f9D964eAc0408E4408b66337b5" as Address;
const NATIVE_TOKEN = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE" as Address;
const CHAIN_NAMES: Readonly<Record<number, string>> = { 4663: "robinhood", 8453: "base" };
const kyberRouterAbi = parseAbi(["function swap((address callTarget,address approveTarget,bytes targetData,(address srcToken,address dstToken,address[] srcReceivers,uint256[] srcAmounts,address[] feeReceivers,uint256[] feeAmounts,address dstReceiver,uint256 amount,uint256 minReturnAmount,uint256 flags,bytes permit) desc,bytes clientData) execution) payable returns (uint256)"]);

type Json = Record<string, unknown>;

export interface KyberSwapQuote {
  source: "kyberswap";
  expectedOut: bigint;
  minimumOut: bigint;
  router: Address;
  routeSummary: Json;
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  chainId: number;
  owner: Address;
  slippageBps: number;
  validUntilMs: number;
}

export class KyberSwapAggregatorApi {
  constructor(
    private readonly clientId: string,
    private readonly defaultSlippageBps: number,
    private readonly timeoutMs = 2_500,
    private readonly maxRouteAgeMs = 10_000,
    private readonly request: typeof fetch = globalThis.fetch,
    private readonly now: () => number = Date.now,
  ) {
    if (!clientId.trim()) throw new Error("KyberSwap client ID is required");
    validateSlippage(defaultSlippageBps);
  }

  async quote(
    position: PositionRecord,
    tokenIn: Address,
    amountIn: bigint,
    tokenOut: Address,
    slippageBps = this.defaultSlippageBps,
  ): Promise<KyberSwapQuote | null> {
    const chain = CHAIN_NAMES[position.chainId];
    if (!chain) return null;
    if (!isAddress(position.owner) || !isAddress(tokenIn) || !isAddress(tokenOut)) throw new Error("KyberSwap quote contains an invalid address");
    if (amountIn <= 0n || amountIn >= 1n << 256n) throw new Error("KyberSwap quote amount must fit uint256");
    validateSlippage(slippageBps);

    const apiTokenIn = kyberToken(tokenIn);
    const apiTokenOut = kyberToken(tokenOut);
    if (apiTokenIn.toLowerCase() === apiTokenOut.toLowerCase()) throw new Error("KyberSwap input and output tokens must differ");
    const query = new URLSearchParams({
      tokenIn: apiTokenIn,
      tokenOut: apiTokenOut,
      amountIn: amountIn.toString(),
      origin: position.owner,
      gasInclude: "true",
      excludeRFQSources: "true",
    });
    const response = await this.request(`${API_URL}/${chain}/api/v1/routes?${query}`, {
      headers: { Accept: "application/json", "x-client-id": this.clientId },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const body = await readJson(response);
    if (!response.ok || body.code !== 0) {
      if (body.code === 4008 || body.code === 4010 || body.code === 4011 || body.code === 4221) return null;
      throw new Error(`KyberSwap /routes failed (${response.status}): ${message(body)}`);
    }

    const data = objectValue(body.data, "data");
    const routeSummary = objectValue(data.routeSummary, "data.routeSummary");
    const router = addressValue(data.routerAddress, "data.routerAddress");
    if (router.toLowerCase() !== KYBER_ROUTER.toLowerCase()) throw new Error("KyberSwap returned an unexpected router");
    assertAddress(routeSummary.tokenIn, apiTokenIn, "route tokenIn");
    assertAddress(routeSummary.tokenOut, apiTokenOut, "route tokenOut");
    const returnedAmountIn = amountValue(routeSummary.amountIn, "route amountIn");
    if (returnedAmountIn !== amountIn) throw new Error("KyberSwap returned a mismatched input amount");
    const expectedOut = amountValue(routeSummary.amountOut, "route amountOut");
    if (expectedOut <= 0n) throw new Error("KyberSwap returned zero output");
    const route = routeSummary.route;
    if (!Array.isArray(route) || route.length === 0 || route.some((path) => !Array.isArray(path) || path.length === 0)) {
      throw new Error("KyberSwap returned an empty route");
    }
    stringValue(routeSummary.routeID, "routeID");
    stringValue(routeSummary.checksum, "checksum");
    assertNoIntegratorFee(routeSummary.extraFee);
    const routeTimestampMs = integerValue(routeSummary.timestamp, "route timestamp") * 1_000;
    const receivedAt = this.now();
    if (routeTimestampMs > receivedAt + 2_000) throw new Error("KyberSwap route timestamp is in the future");
    if (receivedAt - routeTimestampMs > this.maxRouteAgeMs) throw new Error("KyberSwap route is stale");

    return {
      source: "kyberswap",
      expectedOut,
      minimumOut: applySlippage(expectedOut, slippageBps),
      router,
      routeSummary,
      tokenIn,
      tokenOut,
      amountIn,
      chainId: position.chainId,
      owner: position.owner,
      slippageBps,
      validUntilMs: Math.min(receivedAt + this.maxRouteAgeMs, routeTimestampMs + this.maxRouteAgeMs),
    };
  }

  approvalSpender(quote: KyberSwapQuote): Address {
    this.validateQuoteContext(quote);
    return quote.router;
  }

  async createSwap(position: PositionRecord, quote: KyberSwapQuote): Promise<TransactionPlan> {
    this.validateQuoteContext(quote, position);
    const chain = CHAIN_NAMES[position.chainId];
    if (!chain) throw new Error(`KyberSwap does not support chain ${position.chainId}`);
    const response = await this.request(`${API_URL}/${chain}/api/v1/route/build`, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json", "x-client-id": this.clientId },
      body: JSON.stringify({
        routeSummary: quote.routeSummary,
        sender: position.owner,
        recipient: position.owner,
        origin: position.owner,
        slippageTolerance: quote.slippageBps,
        deadline: Math.floor(this.now() / 1_000) + 120,
        enableGasEstimation: false,
        source: this.clientId,
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const body = await readJson(response);
    if (!response.ok || body.code !== 0) throw new Error(`KyberSwap /route/build failed (${response.status}): ${message(body)}`);
    this.validateQuoteContext(quote, position);
    const data = objectValue(body.data, "data");
    const router = addressValue(data.routerAddress, "data.routerAddress");
    if (router.toLowerCase() !== quote.router.toLowerCase() || router.toLowerCase() !== KYBER_ROUTER.toLowerCase()) {
      throw new Error("KyberSwap build returned an unexpected router");
    }
    if (amountValue(data.amountIn, "build amountIn") !== quote.amountIn) throw new Error("KyberSwap build changed the input amount");
    const builtOutput = amountValue(data.amountOut, "build amountOut");
    if (builtOutput < quote.minimumOut) throw new Error("KyberSwap build output is below the accepted minimum");
    const calldata = stringValue(data.data, "build calldata");
    if (!isHex(calldata) || calldata === "0x") throw new Error("KyberSwap build returned invalid calldata");
    validateKyberCalldata(calldata, quote);
    const value = amountValue(data.transactionValue, "build transactionValue");
    if (quote.tokenIn.toLowerCase() === zeroAddress) {
      if (value !== quote.amountIn) throw new Error("KyberSwap native transaction value does not match the input amount");
    } else if (value !== 0n) {
      throw new Error("KyberSwap ERC-20 swap returned a nonzero transaction value");
    }
    return {
      chainId: position.chainId,
      to: router,
      data: calldata,
      value,
      description: "swap through KyberSwap Aggregator API",
    };
  }

  private validateQuoteContext(quote: KyberSwapQuote, position?: PositionRecord): void {
    if (quote.source !== "kyberswap" || quote.router.toLowerCase() !== KYBER_ROUTER.toLowerCase()) {
      throw new Error("Invalid KyberSwap quote context");
    }
    if (this.now() > quote.validUntilMs) throw new Error("KyberSwap route expired before build");
    if (position && (position.chainId !== quote.chainId || position.owner.toLowerCase() !== quote.owner.toLowerCase())) {
      throw new Error("KyberSwap quote does not belong to this position");
    }
  }
}

function validateKyberCalldata(data: Hex, quote: KyberSwapQuote): void {
  let decoded: ReturnType<typeof decodeFunctionData<typeof kyberRouterAbi>>;
  try {
    decoded = decodeFunctionData({ abi: kyberRouterAbi, data });
  } catch {
    throw new Error("KyberSwap returned unsupported router calldata");
  }
  if (decoded.functionName !== "swap") throw new Error("KyberSwap returned unsupported router calldata");
  const description = decoded.args[0].desc;
  const { srcToken, dstToken, srcReceivers, srcAmounts, feeReceivers, feeAmounts, dstReceiver, amount, minReturnAmount, permit } = description;
  if (srcToken.toLowerCase() !== kyberToken(quote.tokenIn).toLowerCase() || dstToken.toLowerCase() !== kyberToken(quote.tokenOut).toLowerCase()) {
    throw new Error("KyberSwap calldata changed the swap tokens");
  }
  // Kyber encodes amountOut and minimumOut one atomic unit below its route summary.
  if (dstReceiver.toLowerCase() !== quote.owner.toLowerCase() || amount !== quote.amountIn || minReturnAmount + 1n < quote.minimumOut) {
    throw new Error("KyberSwap calldata changed the settlement terms");
  }
  if (srcReceivers.length === 0 || srcReceivers.length !== srcAmounts.length || srcAmounts.reduce((sum, value) => sum + value, 0n) !== quote.amountIn) {
    throw new Error("KyberSwap calldata has invalid source allocations");
  }
  if (feeReceivers.length !== 0 || feeAmounts.length !== 0 || permit !== "0x") throw new Error("KyberSwap calldata includes an unexpected fee or permit");
}

function kyberToken(token: Address): Address {
  return token.toLowerCase() === zeroAddress ? NATIVE_TOKEN : token;
}

function applySlippage(amount: bigint, slippageBps: number): bigint {
  return amount * BigInt(10_000 - slippageBps) / 10_000n;
}

function validateSlippage(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > 2_000) throw new Error("KyberSwap slippage must be between 1 and 2000 bps");
}

async function readJson(response: Response): Promise<Json> {
  const value: unknown = await response.json();
  return objectValue(value, "response");
}

function objectValue(value: unknown, name: string): Json {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`KyberSwap ${name} must be an object`);
  return value as Json;
}

function stringValue(value: unknown, name: string): string {
  if (typeof value !== "string" || !value) throw new Error(`KyberSwap ${name} must be a non-empty string`);
  return value;
}

function addressValue(value: unknown, name: string): Address {
  const address = stringValue(value, name);
  if (!isAddress(address)) throw new Error(`KyberSwap ${name} must be an address`);
  return address;
}

function amountValue(value: unknown, name: string): bigint {
  const amount = stringValue(value, name);
  if (!/^\d+$/.test(amount)) throw new Error(`KyberSwap ${name} must be an unsigned integer`);
  return BigInt(amount);
}

function integerValue(value: unknown, name: string): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" && /^\d+$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`KyberSwap ${name} must be an unsigned integer`);
  return parsed;
}

function assertAddress(value: unknown, expected: Address, name: string): void {
  if (addressValue(value, name).toLowerCase() !== expected.toLowerCase()) throw new Error(`KyberSwap returned a mismatched ${name}`);
}

function assertNoIntegratorFee(value: unknown): void {
  if (value === undefined || value === null) return;
  const fee = objectValue(value, "extraFee");
  if ([fee.feeAmount, fee.feeReceiver, fee.chargeFeeBy].some((entry) => entry !== undefined && entry !== null && entry !== "")) {
    throw new Error("KyberSwap returned an unexpected integrator fee");
  }
  if (fee.isInBps !== undefined && fee.isInBps !== false) throw new Error("KyberSwap returned an unexpected integrator fee");
}

function message(body: Json): string {
  const value = body.message ?? body.error;
  return typeof value === "string" && value ? value : "unknown error";
}
