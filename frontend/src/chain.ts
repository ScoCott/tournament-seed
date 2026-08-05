import { defineChain } from "viem";

// GenLayer StudioNet (gasless hosted Studio network).
export const GENLAYER_CHAIN_ID = 61999;
export const GENLAYER_RPC_URL = "https://studio.genlayer.com/api";
export const GENLAYER_EXPLORER_URL = "https://explorer-studio.genlayer.com";

// Deployed TournamentSeed contract on StudioNet.
export const CONTRACT_ADDRESS = "0x1A1fDd783a3ef52927ED0F63f8e72bB264C83977" as const;

// genlayer-js network alias for client.connect(...) and the chains export.
export const GENLAYER_NETWORK = "studionet" as const;

export const genLayerStudioNet = defineChain({
  id: GENLAYER_CHAIN_ID,
  name: "GenLayer StudioNet",
  nativeCurrency: { name: "GEN", symbol: "GEN", decimals: 18 },
  rpcUrls: {
    default: { http: [GENLAYER_RPC_URL] },
    public: { http: [GENLAYER_RPC_URL] },
  },
  blockExplorers: {
    default: { name: "GenLayer Explorer", url: GENLAYER_EXPLORER_URL },
  },
  testnet: true,
});
