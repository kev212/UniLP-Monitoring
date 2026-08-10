import { describe, expect, it, vi } from "vitest";
import { encodeAbiParameters, encodeEventTopics, type Address, type Hex, type TransactionReceipt } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { erc20TransferEvent, v3CollectEvent } from "../src/abi.js";
import type { RuntimeConfig } from "../src/config.js";
import {
  BLINK_ADDRESS,
  BLINK_BUY_LOCK_END_MS,
  BLINK_RESCUE_JOB_ID,
  BLINK_TOKEN_IDS,
  BlinkRescueWorker,
  ROBINHOOD_WETH_ADDRESS,
} from "../src/services/blink-rescue.js";
import type { TokenRescueJob } from "../src/types.js";

const privateKey = `0x${"01".padStart(64, "0")}` as const;
const owner = privateKeyToAccount(privateKey).address;
const positionManager = "0x73991a25c818bf1f1128deaab1492d45638de0d3" as const;

function config(): RuntimeConfig {
  return {
    executorAddress: owner,
    executorPrivateKey: privateKey,
    dryRun: false,
    settlementSwapSlippageBps: 200,
    swapGasLimitMultiplierPercent: 300,
    confirmations: 2,
    blinkRescuePollIntervalMs: 15_000,
    quoteTokens: { base: [], robinhood: [], bsc: [] },
  } as RuntimeConfig;
}

function job(): TokenRescueJob {
  return {
    id: BLINK_RESCUE_JOB_ID,
    chainId: 4663,
    tokenAddress: BLINK_ADDRESS,
    quoteToken: ROBINHOOD_WETH_ADDRESS,
    positionManager,
    tokenIds: [...BLINK_TOKEN_IDS],
    status: "polling",
    pendingRawTransaction: null,
    metadata: {},
    lastError: null,
  };
}

function registry() {
  return { chain: { id: 4663 }, contracts: { v3: { positionManager } } };
}

function receipt(logs: TransactionReceipt["logs"]): TransactionReceipt {
  return { status: "success", logs } as TransactionReceipt;
}

function eventLog(address: Address, topics: Hex[], data: Hex): TransactionReceipt["logs"][number] {
  return { address, topics, data } as TransactionReceipt["logs"][number];
}

describe("BLINK rescue worker", () => {
  it("does not query the NFTs before the immutable buy lock expires", async () => {
    const chains = {
      get: vi.fn(() => ({ registry: registry() })),
      getForScan: vi.fn(),
    };
    const worker = new BlinkRescueWorker(
      {} as never,
      chains as never,
      config(),
      {} as never,
      () => BLINK_BUY_LOCK_END_MS - 60_000,
    );

    await expect(worker.tick(job())).resolves.toBe("waiting");
    expect(chains.getForScan).not.toHaveBeenCalled();
  });

  it("keeps polling when the V3 pool still rejects BLINK collection", async () => {
    const readContract = vi.fn(async ({ functionName }: { functionName: string }) => {
      if (functionName === "ownerOf") return owner;
      return [0n, owner, ROBINHOOD_WETH_ADDRESS, BLINK_ADDRESS, 10_000, 0, 0, 0n, 0n, 0n, 0n, 1n];
    });
    const call = vi.fn().mockRejectedValue(new Error("Execution reverted with reason: TF."));
    const chains = {
      get: vi.fn(() => ({ registry: registry() })),
      getForScan: vi.fn(() => ({ client: { readContract, call } })),
    };
    const database = { setTokenRescueJobState: vi.fn() };
    const worker = new BlinkRescueWorker(
      database as never,
      chains as never,
      config(),
      {} as never,
      () => BLINK_BUY_LOCK_END_MS + 1,
    );

    await expect(worker.tick(job())).resolves.toBe("waiting");
    expect(call).toHaveBeenCalledTimes(1);
    expect(database.setTokenRescueJobState).not.toHaveBeenCalled();
  });

  it("halts safely if one of the rescue NFTs changes ownership", async () => {
    const chains = {
      get: vi.fn(() => ({ registry: registry() })),
      getForScan: vi.fn(() => ({
        client: {
          readContract: vi.fn().mockResolvedValue("0x0000000000000000000000000000000000000001"),
        },
      })),
    };
    const database = { setTokenRescueJobState: vi.fn().mockResolvedValue(job()) };
    const worker = new BlinkRescueWorker(
      database as never,
      chains as never,
      config(),
      {} as never,
      () => BLINK_BUY_LOCK_END_MS + 1,
    );

    await expect(worker.tick(job())).resolves.toBe("complete");
    expect(database.setTokenRescueJobState).toHaveBeenCalledWith(
      BLINK_RESCUE_JOB_ID,
      "needs_review",
      {},
      `NFT ${BLINK_TOKEN_IDS[0]} is no longer owned by the executor`,
      "polling",
    );
  });

  it("recovers a confirmed collect transaction and sums only rescue NFT output", async () => {
    const tokenId = BLINK_TOKEN_IDS[0];
    const collected = 123n * 10n ** 18n;
    const collectLog = eventLog(
      positionManager,
      encodeEventTopics({ abi: [v3CollectEvent], eventName: "Collect", args: { tokenId } }),
      encodeAbiParameters(
        [{ type: "address" }, { type: "uint256" }, { type: "uint256" }],
        [owner, 0n, collected],
      ),
    );
    const confirmed = receipt([collectLog]);
    const client = {
      getTransactionReceipt: vi.fn().mockResolvedValue(confirmed),
      waitForTransactionReceipt: vi.fn().mockResolvedValue(confirmed),
    };
    const chains = {
      get: vi.fn(() => ({ registry: registry() })),
      getForScan: vi.fn(() => ({ client, registry: registry(), transport: {} })),
    };
    const database = {
      withExecutionLock: vi.fn(async (_chainId, _owner, work) => work()),
      clearTokenRescuePendingTransaction: vi.fn().mockResolvedValue(job()),
    };
    const worker = new BlinkRescueWorker(database as never, chains as never, config(), {} as never);
    const pendingJob = {
      ...job(),
      pendingRawTransaction: {
        stage: "collect" as const,
        hash: `0x${"11".repeat(32)}` as Hex,
        serializedTransaction: "0x01" as Hex,
        submittedAt: new Date().toISOString(),
      },
    };

    await expect(worker.tick(pendingJob)).resolves.toBe("progressed");
    expect(database.clearTokenRescuePendingTransaction).toHaveBeenCalledWith(
      BLINK_RESCUE_JOB_ID,
      pendingJob.pendingRawTransaction.hash,
      "collected",
      expect.objectContaining({ collectedBlink: collected.toString() }),
    );
  });

  it("records WETH received by a confirmed rescue swap", async () => {
    const amount = 7n * 10n ** 16n;
    const transferLog = eventLog(
      ROBINHOOD_WETH_ADDRESS,
      encodeEventTopics({ abi: [erc20TransferEvent], eventName: "Transfer", args: {
        from: "0x0000000000000000000000000000000000000004",
        to: owner,
      } }),
      encodeAbiParameters([{ type: "uint256" }], [amount]),
    );
    const confirmed = receipt([transferLog]);
    const client = {
      getTransactionReceipt: vi.fn().mockResolvedValue(confirmed),
      waitForTransactionReceipt: vi.fn().mockResolvedValue(confirmed),
      readContract: vi.fn().mockResolvedValue(amount),
    };
    const chains = {
      get: vi.fn(() => ({ registry: registry() })),
      getForScan: vi.fn(() => ({ client, registry: registry(), transport: {} })),
    };
    const database = {
      withExecutionLock: vi.fn(async (_chainId, _owner, work) => work()),
      clearTokenRescuePendingTransaction: vi.fn().mockResolvedValue(job()),
    };
    const worker = new BlinkRescueWorker(database as never, chains as never, config(), {} as never);
    const pendingJob = {
      ...job(),
      status: "collected" as const,
      metadata: {
        swapOutputPool: "0x0000000000000000000000000000000000000004",
        swapMinimumOut: amount.toString(),
        preSwapWethBalance: "0",
      },
      pendingRawTransaction: {
        stage: "swap" as const,
        hash: `0x${"22".repeat(32)}` as Hex,
        serializedTransaction: "0x02" as Hex,
        submittedAt: new Date().toISOString(),
      },
    };

    await expect(worker.tick(pendingJob)).resolves.toBe("progressed");
    expect(database.clearTokenRescuePendingTransaction).toHaveBeenCalledWith(
      BLINK_RESCUE_JOB_ID,
      pendingJob.pendingRawTransaction.hash,
      "swapped",
      expect.objectContaining({ swapOutputWeth: amount.toString() }),
    );
  });

  it("rejects a route that does not preserve the fixed two-percent minimum", async () => {
    const amount = 100n;
    const client = { readContract: vi.fn().mockResolvedValue(amount) };
    const chains = {
      get: vi.fn(() => ({ registry: registry() })),
      getForScan: vi.fn(() => ({ client })),
    };
    const database = { setTokenRescueJobState: vi.fn().mockResolvedValue(job()) };
    const routes = {
      quoteDirect: vi.fn().mockResolvedValue({
        protocol: "v3",
        pool: "0x0000000000000000000000000000000000000004",
        pools: ["0x0000000000000000000000000000000000000004"],
        router: "0x0000000000000000000000000000000000000005",
        tokenIn: BLINK_ADDRESS,
        tokenOut: ROBINHOOD_WETH_ADDRESS,
        path: [BLINK_ADDRESS, ROBINHOOD_WETH_ADDRESS],
        amountIn: amount,
        expectedOut: 100n,
        minimumOut: 99n,
        fees: [10_000],
        encodedPath: "0x01",
      }),
    };
    const worker = new BlinkRescueWorker(database as never, chains as never, config(), routes as never);
    const collectedJob = { ...job(), status: "collected" as const, metadata: { collectedBlink: amount.toString() } };

    await expect(worker.tick(collectedJob)).resolves.toBe("complete");
    expect(database.setTokenRescueJobState).toHaveBeenCalledWith(
      BLINK_RESCUE_JOB_ID,
      "needs_review",
      {},
      "Rescue route did not enforce the fixed 2% minimum output",
      "collected",
    );
  });
});
