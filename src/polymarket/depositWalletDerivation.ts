import {
  concatHex,
  encodeAbiParameters,
  getAddress,
  hexToBytes,
  keccak256,
  padHex,
  slice,
  toHex,
  type Address,
  type Hex,
} from "viem";
import type { PublicClient } from "viem";

// From `trading-info.md`
export const DEPOSIT_WALLET_FACTORY: Address = "0x00000000000Fb5C9ADea0298D729A0CB3823Cc07";
export const DEPOSIT_WALLET_IMPLEMENTATION: Address = "0x58CA52ebe0DadfdF531Cde7062e76746de4Db1eB";

// Solady LibClone constants (see `initCodeHashERC1967` / `initCodeHashERC1967BeaconProxy`).
const ERC1967_CONST1: Hex =
  "0xcc3735a920a3ca505d382bbc545af43d6000803e6038573d6000fd5b3d6000f3";
const ERC1967_CONST2: Hex =
  "0x5155f3363d3d373d3d363d7f360894a13ba1a3210667c828492db98dca3e2076";

// From Solady assembly: add(0x61003d3d8160233d3973, shl(56, n))
const ERC1967_PREFIX_NO_LEN: bigint = 0x61003d3d8160233d3973n;

// Beacon-proxy constants from Solady.
const BEACON_CONST_A: Hex =
  "0x60195155f3363d3d373d3d363d602036600436635c60da";
const BEACON_CONST_B: Hex =
  "0x1b60e01b36527fa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6c";
const BEACON_CONST_C: Hex =
  "0xb3582b35133d50545afa5036515af43d6000803e604d573d6000fd5b3d6000f3";
const BEACON_PREFIX_NO_LEN: bigint = 0x6100523d8160233d3973n;

function uint64ShiftedLenPrefix(prefixNoLen: bigint, argsLen: number): Hex {
  if (argsLen < 0 || argsLen > 0xffc2) {
    throw new Error(`args too long: ${argsLen}`);
  }
  const withLen = prefixNoLen + (BigInt(argsLen) << 56n);
  // Solidity stores this in a word; we only need the minimal big-endian bytes.
  // The prefix is 10 bytes in the Python implementation; we keep that shape.
  return padHex(toHex(withLen), { size: 10 });
}

export function initCodeHashERC1967(implementation: Address, args: Hex): Hex {
  const argsBytes = hexToBytes(args);
  const n = argsBytes.length;
  const prefix = uint64ShiftedLenPrefix(ERC1967_PREFIX_NO_LEN, n);
  // Mirrors Python SDK:
  // prefix(10) + impl(20) + 0x6009(2) + const2(32) + const1(32) + args(n)
  const initCode = concatHex([prefix, implementation, "0x6009", ERC1967_CONST2, ERC1967_CONST1, args]);
  return keccak256(initCode);
}

export function initCodeHashERC1967BeaconProxy(beacon: Address, args: Hex): Hex {
  const argsBytes = hexToBytes(args);
  const n = argsBytes.length;
  const prefix = uint64ShiftedLenPrefix(BEACON_PREFIX_NO_LEN, n);
  // Based on Solady assembly (see `LibClone.initCodeHashERC1967BeaconProxy(beacon, args)`):
  // prefix(10) + beacon(20) + constA + constB + constC + args(n)
  // The order of constants matches the concatenation order in the initCode generator.
  const initCode = concatHex([prefix, beacon, BEACON_CONST_A, BEACON_CONST_B, BEACON_CONST_C, args]);
  return keccak256(initCode);
}

function create2Address(factory: Address, salt: Hex, initCodeHash: Hex): Address {
  const packed = concatHex(["0xff", factory, salt, initCodeHash]);
  const hash = keccak256(packed);
  // last 20 bytes
  const addr = slice(hash, 12);
  return getAddress(addr);
}

export function walletIdBytes32FromOwner(owner: Address): Hex {
  // bytes32(owner) left-padded to 32 bytes.
  return padHex(owner, { size: 32 });
}

export async function deriveDepositWalletAddress(params: {
  publicClient: Pick<PublicClient, "call" | "getBytecode">;
  owner: Address;
  factory?: Address;
  implementation?: Address;
}): Promise<Address> {
  const factory = params.factory ?? DEPOSIT_WALLET_FACTORY;
  const implementation = params.implementation ?? DEPOSIT_WALLET_IMPLEMENTATION;

  const walletId = walletIdBytes32FromOwner(params.owner);
  const args = encodeAbiParameters(
    [{ type: "address", name: "factory" }, { type: "bytes32", name: "walletId" }],
    [factory, walletId],
  );
  const salt = keccak256(args);

  const uupsHash = initCodeHashERC1967(implementation, args);
  const uupsWallet = create2Address(factory, salt, uupsHash);

  // Probe factory BEACON() (selector 0x49493a4d), per Polymarket docs.
  let beacon: Address | null = null;
  try {
    const out = await params.publicClient.call({
      to: factory,
      data: "0x49493a4d",
    });
    if (out.data && out.data !== "0x" && out.data.length >= 66) {
      const maybe = getAddress(`0x${out.data.slice(out.data.length - 40)}`);
      if (maybe !== "0x0000000000000000000000000000000000000000") beacon = maybe;
    }
  } catch {
    beacon = null;
  }

  if (!beacon) return uupsWallet;

  // If UUPS address is already deployed, keep using it.
  const code = await params.publicClient.getBytecode({ address: uupsWallet });
  if (code && code !== "0x") return uupsWallet;

  const beaconHash = initCodeHashERC1967BeaconProxy(beacon, args);
  return create2Address(factory, salt, beaconHash);
}

