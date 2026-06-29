import type { TickSize } from "./types.js";

export function isPriceOnTick(price: number, tickSize: TickSize): boolean {
  const tick = Number(tickSize);
  if (!Number.isFinite(tick) || tick <= 0) return false;
  if (!Number.isFinite(price) || price <= 0) return false;
  const units = Math.round(price / tick);
  const snapped = units * tick;
  // Avoid floating noise: compare within 1e-12 absolute.
  return Math.abs(snapped - price) <= 1e-12;
}

