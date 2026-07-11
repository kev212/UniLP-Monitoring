import { defineChain, type Address, type Chain } from "viem";
import { base } from "viem/chains";

import type { ChainName } from "./types.js";

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
  chain: Chain;
  contracts: UniswapContracts;
}

export const chainRegistry: Record<ChainName, ChainRegistry> = {
  base: {
    name: "base",
    chain: base,
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
    chain: robinhood,
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
};
