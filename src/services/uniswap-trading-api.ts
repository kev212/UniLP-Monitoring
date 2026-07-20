import { decodeFunctionData, isAddress, isHex, parseAbi, zeroAddress, type Address, type Hex } from "viem";

import type { PositionRecord, TransactionPlan } from "../types.js";

const API_URL = "https://trade-api.gateway.uniswap.org/v1";
const UNIVERSAL_ROUTER_VERSION = "2.1.1";
export const UNISWAP_API_ROUTER = "0x02E5be68D46DAc0B524905bfF209cf47EE6dB2a9" as Address;
const QUOTE_VALIDITY_MS = 10_000;
const TRADING_API_UNIVERSAL_ROUTERS: Readonly<Record<number, Address>> = {
  4663: "0x8876789976decbfcbbbe364623c63652db8c0904",
  8453: "0xFdf682F51FE81Aa4898F0AE2163d8A55c127fbC7",
};
const swapProxyAbi = parseAbi(["function execute(address router,address tokenIn,uint256 amountIn,bytes commands,bytes[] inputs,uint256 deadline) payable"]);

type Json = Record<string, unknown>;

export interface TradingApiQuote {
  raw: Json;
  routing: "CLASSIC";
  expectedOut: bigint;
  minimumOut: bigint;
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  chainId: number;
  owner: Address;
  slippageBps: number;
  validUntilMs: number;
}

interface TradingApiTransaction {
  chainId: number;
  to: Address;
  from: Address;
  data: Hex;
  value: bigint;
}

export class UniswapTradingApi {
  constructor(
    private readonly apiKey: string,
    private readonly slippageBps: number,
    private readonly request: typeof fetch = globalThis.fetch,
    private readonly timeoutMs = 2_500,
  ) {}

  async quote(position: PositionRecord, tokenIn: Address, amountIn: bigint, tokenOut: Address, slippageBps = this.slippageBps): Promise<TradingApiQuote | null> {
    if (!Number.isSafeInteger(slippageBps) || slippageBps < 1 || slippageBps > 2_000) throw new Error("Trading API slippage must be between 1 and 2000 bps");
    const response = await this.post("/quote", {
      swapper: position.owner,
      recipient: position.owner,
      tokenIn,
      tokenOut,
      tokenInChainId: position.chainId,
      tokenOutChainId: position.chainId,
      amount: amountIn.toString(),
      type: "EXACT_INPUT",
      slippageTolerance: slippageBps / 100,
      routingPreference: "BEST_PRICE",
    }, true);
    if (!response) return null;

    if (response.routing !== "CLASSIC") {
      throw new Error(`Trading API returned unsupported ${stringValue(response.routing, "routing")} route`);
    }

    const quote = objectValue(response.quote, "quote");
    if (numberValue(quote.chainId, "quote.chainId") !== position.chainId) throw new Error("Trading API returned a mismatched chain");
    if (addressValue(quote.swapper, "quote.swapper").toLowerCase() !== position.owner.toLowerCase()) throw new Error("Trading API returned a mismatched swapper");
    const input = objectValue(quote.input, "quote.input");
    if (addressValue(input.token, "quote.input.token").toLowerCase() !== tokenIn.toLowerCase()) throw new Error("Trading API returned a mismatched input token");
    if (amountValue(input.amount, "quote.input.amount") !== amountIn) throw new Error("Trading API returned a mismatched input amount");
    const output = objectValue(quote.output, "quote.output");
    if (addressValue(output.token, "quote.output.token").toLowerCase() !== tokenOut.toLowerCase()) throw new Error("Trading API returned a mismatched output token");
    if (addressValue(output.recipient, "quote.output.recipient").toLowerCase() !== position.owner.toLowerCase()) throw new Error("Trading API returned a mismatched recipient");
    const expectedOut = amountValue(output.amount, "quote.output.amount");
    const minimumOut = amountValue(output.minimumAmount, "quote.output.minimumAmount");
    const requestedMinimum = expectedOut * BigInt(10_000 - slippageBps) / 10_000n;
    if (expectedOut <= 0n || minimumOut <= 0n || minimumOut > expectedOut || minimumOut < requestedMinimum) {
      throw new Error("Trading API returned an invalid minimum output");
    }
    if (Array.isArray(quote.txFailureReasons) && quote.txFailureReasons.length > 0) throw new Error("Trading API predicts transaction failure");
    assertNoIntegratorFee(response);
    assertNoIntegratorFee(quote);
    if (Array.isArray(quote.integratorFees) && quote.integratorFees.length > 0) throw new Error("Trading API returned an unexpected integrator fee");
    return {
      raw: response,
      routing: "CLASSIC",
      expectedOut,
      minimumOut,
      tokenIn,
      tokenOut,
      amountIn,
      chainId: position.chainId,
      owner: position.owner,
      slippageBps,
      validUntilMs: Date.now() + QUOTE_VALIDITY_MS,
    };
  }

  async approval(position: PositionRecord, token: Address, amount: bigint): Promise<TradingApiTransaction | null> {
    const response = await this.post("/check_approval", {
      walletAddress: position.owner,
      token,
      amount: amount.toString(),
      chainId: position.chainId,
    });
    if (!response) throw new Error("Trading API returned no approval response");
    if (response.approval === null || response.approval === undefined) return null;
    return parseTransaction(objectValue(response.approval, "approval"), position.chainId, position.owner);
  }

  async createSwap(position: PositionRecord, quote: TradingApiQuote): Promise<TransactionPlan> {
    if (Date.now() > quote.validUntilMs) throw new Error("Trading API quote expired before build");
    if (quote.chainId !== position.chainId || quote.owner.toLowerCase() !== position.owner.toLowerCase()) throw new Error("Trading API quote does not belong to this position");
    const { permitData: _permitData, permitTransaction: _permitTransaction, ...request } = quote.raw;
    const response = await this.post("/swap", {
      ...request,
      refreshGasPrice: true,
      safetyMode: "SAFE",
      deadline: Math.floor(Date.now() / 1_000) + 300,
    });
    if (Date.now() > quote.validUntilMs) throw new Error("Trading API quote expired during build");
    if (!response) throw new Error("Trading API returned no swap response");
    const transaction = parseTransaction(objectValue(response.swap, "swap"), position.chainId, position.owner);
    if (quote.tokenIn.toLowerCase() === zeroAddress) {
      const nativeRouter = TRADING_API_UNIVERSAL_ROUTERS[quote.chainId];
      if (!nativeRouter || transaction.to.toLowerCase() !== nativeRouter.toLowerCase()) throw new Error("Trading API returned an unexpected native swap router");
      if (transaction.value !== quote.amountIn) throw new Error("Trading API native transaction value does not match the input amount");
    } else {
      if (transaction.to.toLowerCase() !== UNISWAP_API_ROUTER.toLowerCase()) throw new Error("Trading API returned an unexpected swap router");
      if (transaction.value !== 0n) throw new Error("Trading API ERC-20 swap returned a nonzero transaction value");
      validateSwapProxyCalldata(transaction.data, quote);
    }
    return {
      chainId: transaction.chainId,
      to: transaction.to,
      data: transaction.data,
      value: transaction.value,
      description: "swap through Uniswap Trading API",
    };
  }

  private async post(path: string, body: Json, noQuoteIsNull = false): Promise<Json | null> {
    const response = await this.request(`${API_URL}${path}`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "x-api-key": this.apiKey,
        "x-universal-router-version": UNIVERSAL_ROUTER_VERSION,
        // This is a server-held executor: use an exact on-chain approval, not a user signature.
        "x-permit2-disabled": "true",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const payload = await readJson(response);
    if (response.ok) return payload;
    if (noQuoteIsNull && response.status === 404 && payload.detail === "No quotes available") return null;
    throw new Error(`Trading API ${path} failed (${response.status}): ${stringValue(payload.detail ?? payload.message ?? payload.error, "error")}`);
  }
}

function validateSwapProxyCalldata(data: Hex, quote: TradingApiQuote): void {
  let decoded: ReturnType<typeof decodeFunctionData<typeof swapProxyAbi>>;
  try {
    decoded = decodeFunctionData({ abi: swapProxyAbi, data });
  } catch {
    throw new Error("Trading API returned unsupported SwapProxy calldata");
  }
  if (decoded.functionName !== "execute") throw new Error("Trading API returned unsupported SwapProxy calldata");
  const [router, tokenIn, amountIn, commands, inputs, deadline] = decoded.args;
  const expectedRouter = TRADING_API_UNIVERSAL_ROUTERS[quote.chainId];
  if (!expectedRouter || router.toLowerCase() !== expectedRouter.toLowerCase()) throw new Error("Trading API calldata targets an unexpected Universal Router");
  if (tokenIn.toLowerCase() !== quote.tokenIn.toLowerCase() || amountIn !== quote.amountIn) throw new Error("Trading API calldata changed the swap input");
  if (commands === "0x" || inputs.length === 0) throw new Error("Trading API calldata has no swap commands");
  const now = BigInt(Math.floor(Date.now() / 1_000));
  if (deadline < now || deadline > now + 1_800n) throw new Error("Trading API calldata has an invalid deadline");
}

function parseTransaction(value: Json, expectedChainId: number, expectedFrom: Address): TradingApiTransaction {
  const chainId = numberValue(value.chainId, "transaction.chainId");
  const to = addressValue(value.to, "transaction.to");
  const from = addressValue(value.from, "transaction.from");
  const data = hexValue(value.data, "transaction.data");
  const rawValue: string = typeof value.value === "string" ? value.value : "0";
  const transactionValue = BigInt(rawValue);
  if (chainId !== expectedChainId) throw new Error(`Trading API returned chain ${chainId}, expected ${expectedChainId}`);
  if (from.toLowerCase() !== expectedFrom.toLowerCase()) throw new Error("Trading API returned an unexpected transaction sender");
  if (data === "0x") throw new Error("Trading API returned empty transaction calldata");
  return { chainId, to, from, data, value: transactionValue };
}

async function readJson(response: Response): Promise<Json> {
  const value: unknown = await response.json();
  return objectValue(value, "response");
}

function objectValue(value: unknown, name: string): Json {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Trading API ${name} must be an object`);
  return value as Json;
}

function stringValue(value: unknown, name: string): string {
  if (typeof value !== "string" || !value) throw new Error(`Trading API ${name} must be a non-empty string`);
  return value;
}

function amountValue(value: unknown, name: string): bigint {
  const amount = stringValue(value, name);
  if (!/^\d+$/.test(amount)) throw new Error(`Trading API ${name} must be an unsigned integer`);
  return BigInt(amount);
}

function numberValue(value: unknown, name: string): number {
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value) && Number.isSafeInteger(Number(value))) return Number(value);
  throw new Error(`Trading API ${name} must be a safe integer`);
}

function addressValue(value: unknown, name: string): Address {
  const address = stringValue(value, name);
  if (!isAddress(address)) throw new Error(`Trading API ${name} must be an address`);
  return address;
}

function assertNoIntegratorFee(value: Json): void {
  for (const key of ["portionBips", "portionAmount", "portionRecipient", "feeAmount", "feeRecipient"]) {
    const entry = value[key];
    if (entry !== undefined && entry !== null && entry !== "" && entry !== "0" && entry !== 0) {
      throw new Error("Trading API returned an unexpected integrator fee");
    }
  }
}

function hexValue(value: unknown, name: string): Hex {
  const hex = stringValue(value, name);
  if (!isHex(hex)) throw new Error(`Trading API ${name} is not hex`);
  return hex;
}
