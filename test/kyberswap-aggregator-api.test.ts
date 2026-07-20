import { describe, expect, it, vi } from "vitest";
import { encodeFunctionData, parseAbi } from "viem";

import { KyberSwapAggregatorApi } from "../src/services/kyberswap-aggregator-api.js";
import type { PositionRecord } from "../src/types.js";

const owner = "0x0000000000000000000000000000000000000001" as const;
const tokenIn = "0x0000000000000000000000000000000000000002" as const;
const tokenOut = "0x0000000000000000000000000000000000000003" as const;
const router = "0x6131B5fae19EA4f9D964eAc0408E4408b66337b5" as const;
const now = 1_800_000_000_000;
const kyberRouterAbi = parseAbi(["function swap((address,address,bytes,(address,address,address[],uint256[],address[],uint256[],address,uint256,uint256,uint256,bytes),bytes)) payable returns (uint256)"]);

function kyberCalldata(minimumOut = 1_078n) {
  return encodeFunctionData({
    abi: kyberRouterAbi,
    functionName: "swap",
    args: [[
      "0x0000000000000000000000000000000000000004",
      "0x0000000000000000000000000000000000000000",
      "0x01",
      [tokenIn, tokenOut, ["0x0000000000000000000000000000000000000004"], [1_000n], [], [], owner, 1_000n, minimumOut, 0n, "0x"],
      "0x",
    ]],
  });
}

const position = {
  id: "position", chainId: 4663, protocol: "v4", positionKey: "1", owner, poolAddress: null,
  token0: tokenIn, token1: tokenOut, quoteToken: tokenOut, status: "closing", liquidity: null,
  openedAtBlock: null, metadata: {},
} satisfies PositionRecord;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function routeResponse(overrides: Record<string, unknown> = {}) {
  return {
    code: 0,
    message: "successfully",
    data: {
      routerAddress: router,
      routeSummary: {
        tokenIn,
        tokenOut,
        amountIn: "1000",
        amountOut: "1100",
        route: [[{ exchange: "uniswapv3" }]],
        routeID: "route-id",
        checksum: "checksum",
        timestamp: Math.floor(now / 1_000),
        extraFee: { feeAmount: "", feeReceiver: "", chargeFeeBy: "", isInBps: false },
        ...overrides,
      },
    },
  };
}

describe("KyberSwapAggregatorApi", () => {
  it("quotes Robinhood routes and builds validated calldata", async () => {
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json(routeResponse()))
      .mockResolvedValueOnce(json({
        code: 0,
        data: {
          routerAddress: router,
          amountIn: "1000",
          amountOut: "1100",
          transactionValue: "0",
          data: kyberCalldata(),
        },
      }));
    const api = new KyberSwapAggregatorApi("UniLP-Monitoring", 200, 2_500, 10_000, request, () => now);

    const quote = await api.quote(position, tokenIn, 1_000n, tokenOut);
    expect(quote).toMatchObject({ expectedOut: 1_100n, minimumOut: 1_078n, router, slippageBps: 200 });
    expect(String(request.mock.calls[0]![0])).toContain("/robinhood/api/v1/routes?");
    expect(String(request.mock.calls[0]![0])).toContain("excludeRFQSources=true");
    expect(request.mock.calls[0]![1]?.headers).toMatchObject({ "x-client-id": "UniLP-Monitoring" });

    const plan = await api.createSwap(position, quote!);
    expect(plan).toEqual({ chainId: 4663, to: router, data: kyberCalldata(), value: 0n, description: "swap through KyberSwap Aggregator API" });
    const buildBody = JSON.parse(String(request.mock.calls[1]![1]?.body));
    expect(buildBody).toMatchObject({ sender: owner, recipient: owner, origin: owner, slippageTolerance: 200, enableGasEstimation: false });
    expect(buildBody.routeSummary).toEqual(routeResponse().data.routeSummary);
  });

  it("returns null when no eligible route exists", async () => {
    const api = new KyberSwapAggregatorApi("client", 200, 2_500, 10_000, async () => json({ code: 4008, message: "Route not found" }, 400), () => now);

    await expect(api.quote(position, tokenIn, 1_000n, tokenOut)).resolves.toBeNull();
  });

  it("rejects stale routes and unexpected routers", async () => {
    const stale = new KyberSwapAggregatorApi("client", 200, 2_500, 10_000, async () => json(routeResponse({ timestamp: Math.floor(now / 1_000) - 11 })), () => now);
    await expect(stale.quote(position, tokenIn, 1_000n, tokenOut)).rejects.toThrow("stale");

    const badRouter = new KyberSwapAggregatorApi("client", 200, 2_500, 10_000, async () => json({
      ...routeResponse(),
      data: { ...routeResponse().data, routerAddress: "0x0000000000000000000000000000000000000004" },
    }), () => now);
    await expect(badRouter.quote(position, tokenIn, 1_000n, tokenOut)).rejects.toThrow("unexpected router");
  });

  it("rejects build output below the accepted minimum", async () => {
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json(routeResponse()))
      .mockResolvedValueOnce(json({ code: 0, data: { routerAddress: router, amountIn: "1000", amountOut: "1000", transactionValue: "0", data: kyberCalldata(1_000n) } }));
    const api = new KyberSwapAggregatorApi("client", 200, 2_500, 10_000, request, () => now);
    const quote = await api.quote(position, tokenIn, 1_000n, tokenOut);

    await expect(api.createSwap(position, quote!)).rejects.toThrow("below the accepted minimum");
  });
});
