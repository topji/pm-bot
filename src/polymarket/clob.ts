import { ClobClient, SignatureTypeV2 } from "@polymarket/clob-client-v2";
import { polygon } from "viem/chains";
import type { WalletClient } from "viem";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";

import type { Endpoints } from "./endpoints.js";

const ClobCredsSchema = z.object({
  key: z.string().min(1),
  secret: z.string().min(1),
  passphrase: z.string().min(1),
});

export type ClobCreds = z.infer<typeof ClobCredsSchema>;

export async function loadOrCreateClobCreds(params: {
  endpoints: Endpoints;
  signer: WalletClient;
  credsPath: string;
}): Promise<ClobCreds> {
  try {
    const raw = await readFile(params.credsPath, "utf8");
    const json = JSON.parse(raw) as unknown;
    const parsed = ClobCredsSchema.safeParse(json);
    if (parsed.success) return parsed.data;
  } catch {
    // fallthrough
  }

  const bootstrap = new ClobClient({
    host: params.endpoints.clobHost,
    chain: polygon.id,
    signer: params.signer,
    useServerTime: true,
  });

  const credsUnknown = (await bootstrap.createOrDeriveApiKey()) as unknown;
  const parsed = ClobCredsSchema.safeParse(credsUnknown);
  if (!parsed.success) {
    throw new Error(`CLOB creds derivation returned unexpected shape: ${parsed.error.message}`);
  }

  await mkdir(dirname(params.credsPath), { recursive: true });
  await writeFile(params.credsPath, JSON.stringify(parsed.data, null, 2), { encoding: "utf8" });
  return parsed.data;
}

export function createDepositWalletClobClient(params: {
  endpoints: Endpoints;
  signer: WalletClient;
  creds: ClobCreds;
  depositWalletAddress: string;
}): ClobClient {
  return new ClobClient({
    host: params.endpoints.clobHost,
    chain: polygon.id,
    signer: params.signer,
    creds: params.creds,
    signatureType: SignatureTypeV2.POLY_1271,
    funderAddress: params.depositWalletAddress,
    useServerTime: true,
  });
}

