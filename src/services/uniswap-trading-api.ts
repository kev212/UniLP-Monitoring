import { isAddress, isHex, type Address, type Hex } from "viem";

import type { PositionRecord, TransactionPlan } from "../types.js";

const API_URL = "https://trade-api.gateway.uniswap.org/v1";
const UNIVERSAL_ROUTER_VERSION = "2.1.1";

type Json = Record<string, unknown>;

export interface TradingApiQuote {
  raw: Json;
  routing: "CLASSIC";
  expectedOut: bigint;
  minimumOut: bigint;
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
  ) {}

  async quote(position: PositionRecord, tokenIn: Address, amountIn: bigint, tokenOut: Address): Promise<TradingApiQuote | null> {
    const response = await this.post("/quote", {
      swapper: position.owner,
      recipient: position.owner,
      tokenIn,
      tokenOut,
      tokenInChainId: position.chainId,
      tokenOutChainId: position.chainId,
      amount: amountIn.toString(),
      type: "EXACT_INPUT",
      slippageTolerance: this.slippageBps / 100,
      routingPreference: "BEST_PRICE",
    }, true);
    if (!response) return null;

    if (response.routing !== "CLASSIC") {
      throw new Error(`Trading API returned unsupported ${stringValue(response.routing, "routing")} route`);
    }

    const quote = objectValue(response.quote, "quote");
    const output = objectValue(quote.output, "quote.output");
    const expectedOut = amountValue(output.amount, "quote.output.amount");
    const minimumOut = amountValue(output.minimumAmount ?? output.amount, "quote.output.minimumAmount");
    return { raw: response, routing: "CLASSIC", expectedOut, minimumOut };
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
    const { permitData: _permitData, permitTransaction: _permitTransaction, ...request } = quote.raw;
    const response = await this.post("/swap", {
      ...request,
      refreshGasPrice: true,
      safetyMode: "SAFE",
      deadline: Math.floor(Date.now() / 1_000) + 300,
    });
    if (!response) throw new Error("Trading API returned no swap response");
    const transaction = parseTransaction(objectValue(response.swap, "swap"), position.chainId, position.owner);
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
    });
    const payload = await readJson(response);
    if (response.ok) return payload;
    if (noQuoteIsNull && response.status === 404 && payload.detail === "No quotes available") return null;
    throw new Error(`Trading API ${path} failed (${response.status}): ${stringValue(payload.detail ?? payload.message ?? payload.error, "error")}`);
  }
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
  if (!isAddress(address)) throw new Error(`Trading API ${name} is not an address`);
  return address;
}

function hexValue(value: unknown, name: string): Hex {
  const hex = stringValue(value, name);
  if (!isHex(hex)) throw new Error(`Trading API ${name} is not hex`);
  return hex;
}
