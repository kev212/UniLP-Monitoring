import { isAddress, zeroAddress, type Address, type Hex } from "viem";

import type { RuntimeConfig } from "../config.js";
import type { Database } from "../db.js";
import { log } from "../log.js";
import type { ChainName } from "../types.js";
import type { ChainClients } from "./chain-client.js";
import type { DiscoveryService, NftActivity, WalletActivity } from "./discovery.js";

type AssetCategory = "erc20" | "erc721" | "erc1155";

interface AlchemyTransfer {
  uniqueId?: string;
  blockNum?: string;
  hash?: string;
  from?: string;
  to?: string;
  tokenId?: string;
  category?: AssetCategory;
  rawContract?: { address?: string };
}

interface AssetTransfersResponse {
  transfers?: AlchemyTransfer[];
  pageKey?: string;
}

interface IndexedActivity extends WalletActivity {
  category: AssetCategory;
  tokenId?: bigint;
}

export class AlchemyBootstrapper {
  constructor(
    private readonly database: Database,
    private readonly chains: ChainClients,
    private readonly discovery: DiscoveryService,
    private readonly config: RuntimeConfig,
  ) {}

  isEnabled(name: ChainName): boolean {
    return Boolean(this.config.alchemyHttp[name]);
  }

  async bootstrap(name: ChainName): Promise<void> {
    const { client, registry } = this.chains.get(name);
    if (await this.database.getBootstrap(registry.chain.id)) return;
    const endpoint = this.config.alchemyHttp[name];
    if (!endpoint) return;

    const activities = await this.listWalletActivities(endpoint, this.config.executorAddress);
    const v2Activities = activities.filter((activity) => activity.category === "erc20");
    const v2Positions = await this.discovery.discoverV2Activities(name, v2Activities);
    const v3Candidates = this.nftCandidates(activities, registry.contracts.v3.positionManager);
    const v4Candidates = this.nftCandidates(activities, registry.contracts.v4.positionManager);
    const v3Positions = await this.discovery.discoverV3Candidates(name, v3Candidates);
    await this.discovery.discoverV4Candidates(name, v4Candidates);
    await this.discovery.reconcileV4Liquidity(name);

    const latest = await client.getBlockNumber();
    for (const position of v3Positions) {
      const candidate = v3Candidates.find((item) => item.tokenId.toString() === position.positionKey);
      if (candidate?.historyTrusted) {
        await this.discovery.hydrateV3History(name, position, candidate.blockNumber, latest);
      }
    }
    await this.discovery.hydrateV4Activities(name, activities);
    await this.database.saveCursor(registry.chain.id, latest);
    await this.database.markBootstrapComplete(registry.chain.id, "alchemy", latest);
    log.info({
      chain: name,
      activities: activities.length,
      v2Positions: v2Positions.length,
      v3Positions: v3Positions.length,
      v4Candidates: v4Candidates.length,
      latest,
    }, "Alchemy wallet bootstrap completed");
  }

  private async listWalletActivities(endpoint: string, owner: Address): Promise<IndexedActivity[]> {
    const [incoming, outgoing] = await Promise.all([
      this.listTransfers(endpoint, { toAddress: owner }),
      this.listTransfers(endpoint, { fromAddress: owner }),
    ]);
    const activities = new Map<string, IndexedActivity>();
    for (const activity of [...incoming, ...outgoing]) {
      const key = `${activity.transactionHash}-${activity.asset.toLowerCase()}-${activity.tokenId?.toString() ?? ""}-${activity.category}`;
      const existing = activities.get(key);
      if (!existing || activity.blockNumber < existing.blockNumber) activities.set(key, activity);
    }
    return [...activities.values()].sort((left, right) => (left.blockNumber < right.blockNumber ? -1 : left.blockNumber > right.blockNumber ? 1 : 0));
  }

  private async listTransfers(endpoint: string, direction: { fromAddress?: Address; toAddress?: Address }): Promise<IndexedActivity[]> {
    const results: IndexedActivity[] = [];
    let pageKey: string | undefined;
    for (let page = 0; page < 10_000; page += 1) {
      const response = await this.request<AssetTransfersResponse>(endpoint, "alchemy_getAssetTransfers", [{
        fromBlock: "0x0",
        toBlock: "latest",
        category: ["erc20", "erc721", "erc1155"],
        withMetadata: false,
        excludeZeroValue: false,
        maxCount: "0x3e8",
        order: "asc",
        ...direction,
        ...(pageKey ? { pageKey } : {}),
      }]);
      for (const transfer of response.transfers ?? []) {
        const activity = parseAssetTransfer(transfer);
        if (activity) results.push(activity);
      }
      if (!response.pageKey) return results;
      pageKey = response.pageKey;
    }
    throw new Error("Alchemy asset transfer pagination exceeded 10,000 pages");
  }

  private async request<T>(endpoint: string, method: string, params: unknown[]): Promise<T> {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: crypto.randomUUID(), method, params }),
    });
    if (!response.ok) throw new Error(`Alchemy request failed with HTTP ${response.status}`);
    const body = await response.json() as { result?: T; error?: { code?: number; message?: string } };
    if (body.error) throw new Error(`Alchemy ${body.error.code ?? "error"}: ${body.error.message ?? "unknown error"}`);
    if (!body.result) throw new Error("Alchemy returned an empty result");
    return body.result;
  }

  private nftCandidates(activities: IndexedActivity[], manager: Address): NftActivity[] {
    const candidates = new Map<bigint, NftActivity>();
    for (const activity of activities) {
      if ((activity.category !== "erc721" && activity.category !== "erc1155") || activity.asset.toLowerCase() !== manager.toLowerCase() || activity.tokenId === undefined) continue;
      const directlyMinted = activity.from?.toLowerCase() === zeroAddress && activity.to?.toLowerCase() === this.config.executorAddress.toLowerCase();
      const existing = candidates.get(activity.tokenId);
      if (!existing || directlyMinted || activity.blockNumber < existing.blockNumber) {
        candidates.set(activity.tokenId, {
          asset: manager,
          transactionHash: activity.transactionHash,
          blockNumber: activity.blockNumber,
          from: activity.from,
          to: activity.to,
          tokenId: activity.tokenId,
          historyTrusted: directlyMinted || Boolean(existing?.historyTrusted),
        });
      }
    }
    return [...candidates.values()];
  }
}

export function parseAssetTransfer(transfer: AlchemyTransfer): IndexedActivity | null {
  const address = transfer.rawContract?.address;
  if (!address || !isAddress(address, { strict: false }) || !transfer.hash || !transfer.blockNum || !transfer.category) return null;
  if (transfer.category !== "erc20" && transfer.category !== "erc721" && transfer.category !== "erc1155") return null;
  let tokenId: bigint | undefined;
  if (transfer.tokenId !== undefined) {
    try {
      tokenId = BigInt(transfer.tokenId);
    } catch {
      return null;
    }
  }
  return {
    asset: address as Address,
    transactionHash: transfer.hash as Hex,
    blockNumber: BigInt(transfer.blockNum),
    from: normalizeAddress(transfer.from),
    to: normalizeAddress(transfer.to),
    tokenId,
    category: transfer.category,
  };
}

function normalizeAddress(value: string | undefined): Address | undefined {
  return value && isAddress(value, { strict: false }) ? value as Address : undefined;
}
