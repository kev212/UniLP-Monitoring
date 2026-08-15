import { defineChain, zeroAddress, type Address, type Chain } from "viem";
import { base, bsc } from "viem/chains";

import type { ChainName, Protocol } from "./types.js";

const robinhood = defineChain({
  id: 4663,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: {
    default: { http: ["https://rpc.mainnet.chain.robinhood.com"] },
  },
  blockExplorers: {
    default: { name: "Robinhood Chain Explorer", url: "https://robinhoodchain.blockscout.com" },
  },
});

export interface UniswapContracts {
  v2: { factory: Address; router: Address };
  v3: { factory: Address; positionManager: Address; quoter: Address; swapRouter: Address };
  v4: { poolManager: Address; positionManager: Address; quoter: Address; stateView: Address; universalRouter: Address; permit2: Address };
}

export interface ChainRegistry {
  name: ChainName;
  aliases: readonly string[];
  chain: Chain;
  contracts: UniswapContracts;
  discoveryProtocols: readonly Protocol[];
  monitoringEnabled: boolean;
  dex: "uniswap";
  displayName: string;
  nativeSymbol: string;
  wrappedSymbol: string;
  wrappedNative: Address;
  geckoNetwork: string;
  geckoV4DexId: string;
  dexScreenerChain: string;
  uniswapSlug: string;
  explorerUrl: string;
  quotePriority: readonly string[];
}

export const chainRegistry: Record<ChainName, ChainRegistry> = {
  base: {
    name: "base",
    aliases: ["base"],
    chain: base,
    discoveryProtocols: ["v2", "v3", "v4"],
    monitoringEnabled: true,
    dex: "uniswap",
    displayName: "Base",
    nativeSymbol: "ETH",
    wrappedSymbol: "WETH",
    wrappedNative: "0x4200000000000000000000000000000000000006",
    geckoNetwork: "base",
    geckoV4DexId: "uniswap-v4-base",
    dexScreenerChain: "base",
    uniswapSlug: "base",
    explorerUrl: "https://basescan.org",
    quotePriority: ["USDC", "WETH", "ETH"],
    contracts: {
      v2: {
        factory: "0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6",
        router: "0x4752ba5dbc23f44d87826276bf6fd6b1c372ad24",
      },
      v3: {
        factory: "0x33128a8fC17869897dcE68Ed026d694621f6FDfD",
        positionManager: "0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1",
        quoter: "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a",
        swapRouter: "0x2626664c2603336E57B271c5C0b26F421741e481",
      },
      v4: {
        poolManager: "0x498581ff718922c3f8e6a244956af099b2652b2b",
        positionManager: "0x7c5f5a4bbd8fd63184577525326123b519429bdc",
        quoter: "0x0d5e0f971ed27fbff6c2837bf31316121532048d",
        stateView: "0xa3c0c9b65bad0b08107aa264b0f3db444b867a71",
        universalRouter: "0x6ff5693b99212da76ad316178a184ab56d299b43",
        permit2: "0x000000000022d473030f116ddee9f6b43ac78ba3",
      },
    },
  },
  robinhood: {
    name: "robinhood",
    aliases: ["robinhood"],
    chain: robinhood,
    discoveryProtocols: ["v2", "v3", "v4"],
    monitoringEnabled: true,
    dex: "uniswap",
    displayName: "Robinhood Chain",
    nativeSymbol: "ETH",
    wrappedSymbol: "WETH",
    wrappedNative: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
    geckoNetwork: "robinhood",
    geckoV4DexId: "uniswap-v4-robinhood",
    dexScreenerChain: "robinhood",
    uniswapSlug: "robinhood",
    explorerUrl: "https://robinhoodchain.blockscout.com",
    quotePriority: ["USDG", "USDC", "WETH", "ETH", "NVDA"],
    contracts: {
      v2: {
        factory: "0x8bceaa40b9acdfaedf85adf4ff01f5ad6517937f",
        router: "0x89e5db8b5aa49aa85ac63f691524311aeb649eba",
      },
      v3: {
        factory: "0x1f7d7550b1b028f7571e69a784071f0205fd2efa",
        positionManager: "0x73991a25c818bf1f1128deaab1492d45638de0d3",
        quoter: "0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7",
        swapRouter: "0xcaf681a66d020601342297493863e78c959e5cb2",
      },
      v4: {
        poolManager: "0x8366a39cc670b4001a1121b8f6a443a643e40951",
        positionManager: "0x58daec3116aae6d93017baaea7749052e8a04fa7",
        quoter: "0x8dc178efb8111bb0973dd9d722ebeff267c98f94",
        stateView: "0xf3334192d15450cdd385c8b70e03f9a6bd9e673b",
        universalRouter: "0x8876789976decbfcbbbe364623c63652db8c0904",
        permit2: "0x000000000022d473030f116ddee9f6b43ac78ba3",
      },
    },
  },
  bsc: {
    name: "bsc",
    aliases: ["bsc", "bnb"],
    chain: bsc,
    discoveryProtocols: ["v3", "v4"],
    monitoringEnabled: true,
    dex: "uniswap",
    displayName: "BNB Smart Chain",
    nativeSymbol: "BNB",
    wrappedSymbol: "WBNB",
    wrappedNative: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c",
    geckoNetwork: "bsc",
    geckoV4DexId: "uniswap-v4-bsc",
    dexScreenerChain: "bsc",
    uniswapSlug: "bnb",
    explorerUrl: "https://bscscan.com",
    quotePriority: ["USDT", "WBNB", "BNB"],
    contracts: {
      v2: { factory: zeroAddress, router: zeroAddress },
      v3: {
        factory: "0xdB1d10011AD0Ff90774D0C6Bb92e5C5c8b4461F7",
        positionManager: "0x7b8A01B39D58278b5DE7e48c8449c9f4F5170613",
        quoter: "0x78D78E420Da98ad378D7799bE8f4AF69033EB077",
        swapRouter: "0xB971eF87ede563556b2ED4b1C0b0019111Dd85d2",
      },
      v4: {
        poolManager: "0x28e2ea090877bf75740558f6bfb36a5ffee9e9df",
        positionManager: "0x7a4a5c919ae2541aed11041a1aeee68f1287f95b",
        quoter: "0x9f75dd27d6664c475b90e105573e550ff69437b0",
        stateView: "0xd13dd3d6e93f276fafc9db9e6bb47c1180aee0c4",
        universalRouter: "0x1906c1d672b88cd1b9ac7593301ca990f94eae07",
        permit2: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
      },
    },
  },
};

export function parseChainAlias(value: string): ChainName | undefined {
  const normalized = value.trim().toLowerCase();
  for (const registry of Object.values(chainRegistry)) {
    if (registry.aliases.includes(normalized)) return registry.name;
  }
  return undefined;
}

export function registryByChainId(chainId: number): ChainRegistry | undefined {
  return Object.values(chainRegistry).find((registry) => registry.chain.id === chainId);
}

export function isProtocolDeployed(registry: ChainRegistry, protocol: Protocol): boolean {
  if (registry.discoveryProtocols && !registry.discoveryProtocols.includes(protocol)) return false;
  if (!registry.contracts) return true;
  if (!registry.discoveryProtocols) {
    if (protocol === "v2") return Boolean(registry.contracts.v2);
    if (protocol === "v3") return Boolean(registry.contracts.v3);
    return Boolean(registry.contracts.v4);
  }
  if (protocol === "v2") return registry.contracts.v2?.factory !== zeroAddress && registry.contracts.v2?.router !== zeroAddress;
  if (protocol === "v3") return registry.contracts.v3?.factory !== zeroAddress && registry.contracts.v3?.positionManager !== zeroAddress;
  return registry.contracts.v4?.poolManager !== zeroAddress && registry.contracts.v4?.positionManager !== zeroAddress;
}

export function isEligibleScanDex(registry: ChainRegistry, dexId: string): boolean {
  if (registry.name === "bsc") {
    return dexId === registry.geckoV4DexId || dexId === "uniswap-v3-bsc" || dexId === "uniswap-bsc";
  }
  return dexId.startsWith("uniswap-v3") || dexId.startsWith("uniswap-v4");
}

export function isWrappedNative(registry: ChainRegistry, address: Address): boolean {
  return address.toLowerCase() === registry.wrappedNative.toLowerCase();
}

export function chainHeading(registry: ChainRegistry): string {
  return `${registry.displayName} (${registry.chain.id})`;
}
