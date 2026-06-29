import { createPublicClient, createWalletClient, http, type Address, type Hex } from "viem";
import { polygon } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { deriveDepositWalletAddress } from "./depositWalletDerivation.js";

export type BotWallets = {
  accountAddress: Address;
  walletClient: ReturnType<typeof createWalletClient>;
  publicClient: ReturnType<typeof createPublicClient>;
};

export type BotPublicClient = BotWallets["publicClient"];
export type BotWalletClient = BotWallets["walletClient"];

export function createBotWallets(botPrivateKey: Hex, rpcUrl?: string): BotWallets {
  const account = privateKeyToAccount(botPrivateKey);
  const transport = http(rpcUrl);
  const walletClient = createWalletClient({
    account,
    chain: polygon,
    transport,
  });
  const publicClient = createPublicClient({ chain: polygon, transport });

  return {
    accountAddress: account.address,
    walletClient,
    publicClient,
  };
}

export async function deriveDepositWalletForBot(wallets: BotWallets): Promise<Address> {
  return deriveDepositWalletAddress({
    publicClient: wallets.publicClient,
    owner: wallets.accountAddress,
  });
}

