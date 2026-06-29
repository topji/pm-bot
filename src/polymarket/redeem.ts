import { encodeFunctionData, zeroHash, type Address, type Hex } from "viem";
import { z } from "zod";

import type { GammaMarket } from "./types.js";
import type { BotPublicClient, BotWalletClient } from "./wallets.js";

// From `trading-info.md`
export const CTF_ADDRESS: Address = "0x4d97dcd97ec945f40cf65f87097ace5ea0476045";
export const PUSD_ADDRESS: Address = "0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB";
export const NEG_RISK_ADAPTER_ADDRESS: Address = "0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296";

const Bytes32Schema = z.string().regex(/^0x[0-9a-fA-F]{64}$/);

const CtfRedeemAbi = [
  {
    type: "function",
    name: "redeemPositions",
    stateMutability: "nonpayable",
    inputs: [
      { name: "collateralToken", type: "address" },
      { name: "parentCollectionId", type: "bytes32" },
      { name: "conditionId", type: "bytes32" },
      { name: "indexSets", type: "uint256[]" },
    ],
    outputs: [],
  },
] as const;

const Erc1155Abi = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [
      { name: "account", type: "address" },
      { name: "id", type: "uint256" },
    ],
    outputs: [{ name: "balance", type: "uint256" }],
  },
] as const;

const NrAdapterRedeemAbi = [
  {
    type: "function",
    name: "redeemPositions",
    stateMutability: "nonpayable",
    inputs: [
      { name: "_conditionId", type: "bytes32" },
      { name: "_amounts", type: "uint256[]" },
    ],
    outputs: [],
  },
] as const;

function tokenIdToBigInt(tokenId: string): bigint {
  // Gamma/CLOB token IDs are decimal strings for ERC-1155 position IDs.
  const n = BigInt(tokenId);
  if (n <= 0n) throw new Error("tokenId must be positive");
  return n;
}

export async function redeemResolvedPosition(params: {
  walletClient: BotWalletClient;
  publicClient: BotPublicClient;
  depositWalletAddress: Address;
  market: GammaMarket;
}): Promise<Hex> {
  const conditionId = Bytes32Schema.parse(params.market.conditionId) as Hex;

  if (!params.market.negRisk) {
    const hash = await params.walletClient.writeContract({
      address: CTF_ADDRESS,
      abi: CtfRedeemAbi,
      functionName: "redeemPositions",
      args: [PUSD_ADDRESS, zeroHash, conditionId, [1n, 2n]],
      account: params.walletClient.account!,
      chain: null,
    });
    return hash;
  }

  // Neg-risk redemption: use adapter and pass exact redeem amounts per side.
  const upId = tokenIdToBigInt(params.market.upTokenId);
  const downId = tokenIdToBigInt(params.market.downTokenId);

  const [upBal, downBal] = await Promise.all([
    params.publicClient.readContract({
      address: CTF_ADDRESS,
      abi: Erc1155Abi,
      functionName: "balanceOf",
      args: [params.depositWalletAddress, upId],
    }),
    params.publicClient.readContract({
      address: CTF_ADDRESS,
      abi: Erc1155Abi,
      functionName: "balanceOf",
      args: [params.depositWalletAddress, downId],
    }),
  ]);

  const hash = await params.walletClient.writeContract({
    address: NEG_RISK_ADAPTER_ADDRESS,
    abi: NrAdapterRedeemAbi,
    functionName: "redeemPositions",
    args: [conditionId, [upBal, downBal]],
    account: params.walletClient.account!,
    chain: null,
  });

  return hash;
}

export function buildCtfRedeemCalldata(params: { conditionId: Hex }): Hex {
  // Useful for relayer batching later.
  return encodeFunctionData({
    abi: CtfRedeemAbi,
    functionName: "redeemPositions",
    args: [PUSD_ADDRESS, zeroHash, params.conditionId, [1n, 2n]],
  });
}

