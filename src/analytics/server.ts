import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type Database from "better-sqlite3";
import type pino from "pino";

import type { AnalyticsConfig } from "./config.js";
import { serializeTradeRound } from "./dto.js";
import {
  countTradeEvents,
  countTradeRounds,
  getAnalyticsSummary,
  getDailyPnl,
  getTradeRound,
  listTradeEvents,
  listTradeRounds,
} from "./queries.js";
import type { OrderSide } from "../polymarket/types.js";

type JsonBody = Record<string, unknown> | unknown[];

function sendJson(res: ServerResponse, status: number, body: JsonBody, corsOrigin: string): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": corsOrigin,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  });
  res.end(payload);
}

function parseOrderSide(value: string | null): OrderSide | undefined {
  if (!value) return undefined;
  const upper = value.toUpperCase();
  if (upper === "UP" || upper === "DOWN") return upper;
  return undefined;
}

function parseBool(value: string | null): boolean | undefined {
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  return undefined;
}

function parseLimit(value: string | null, fallback: number, max: number): number {
  const n = value ? Number(value) : fallback;
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(Math.floor(n), max);
}

function parseOffset(value: string | null): number {
  const n = value ? Number(value) : 0;
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}

function isAuthorized(req: IncomingMessage, apiKey: string | undefined): boolean {
  if (!apiKey) return true;
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return false;
  return header.slice("Bearer ".length) === apiKey;
}

function notFound(res: ServerResponse, corsOrigin: string): void {
  sendJson(res, 404, { error: "not_found" }, corsOrigin);
}

function unauthorized(res: ServerResponse, corsOrigin: string): void {
  sendJson(res, 401, { error: "unauthorized" }, corsOrigin);
}

export function createAnalyticsServer(params: {
  config: AnalyticsConfig;
  db: Database.Database;
  log: pino.Logger;
}): ReturnType<typeof createServer> {
  const { config, db, log } = params;

  return createServer((req, res) => {
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": config.analyticsCorsOrigin,
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
      });
      res.end();
      return;
    }

    if (req.method !== "GET") {
      sendJson(res, 405, { error: "method_not_allowed" }, config.analyticsCorsOrigin);
      return;
    }

    if (!isAuthorized(req, config.analyticsApiKey)) {
      unauthorized(res, config.analyticsCorsOrigin);
      return;
    }

    const url = new URL(req.url ?? "/", `http://${config.analyticsHost}:${config.analyticsPort}`);

    try {
      if (url.pathname === "/health") {
        sendJson(
          res,
          200,
          { status: "ok", dbPath: config.dbPath, timestampMs: Date.now() },
          config.analyticsCorsOrigin,
        );
        return;
      }

      if (url.pathname === "/api/v1/summary") {
        const orderSide = parseOrderSide(url.searchParams.get("order_side"));
        sendJson(res, 200, { data: getAnalyticsSummary(db, orderSide) }, config.analyticsCorsOrigin);
        return;
      }

      if (url.pathname === "/api/v1/summary/daily") {
        const orderSide = parseOrderSide(url.searchParams.get("order_side"));
        const days = parseLimit(url.searchParams.get("days"), 30, 365);
        sendJson(
          res,
          200,
          { data: getDailyPnl(db, { days, orderSide }) },
          config.analyticsCorsOrigin,
        );
        return;
      }

      if (url.pathname === "/api/v1/rounds") {
        const filter = {
          orderSide: parseOrderSide(url.searchParams.get("order_side")),
          filled: parseBool(url.searchParams.get("filled")),
          exitType: url.searchParams.get("exit_type") ?? undefined,
          limit: parseLimit(url.searchParams.get("limit"), 50, 500),
          offset: parseOffset(url.searchParams.get("offset")),
        };
        const total = countTradeRounds(db, filter);
        const rows = listTradeRounds(db, filter).map(serializeTradeRound);
        sendJson(
          res,
          200,
          { data: rows, meta: { total, limit: filter.limit, offset: filter.offset } },
          config.analyticsCorsOrigin,
        );
        return;
      }

      const roundMatch = /^\/api\/v1\/rounds\/([^/]+)\/(UP|DOWN)$/i.exec(url.pathname);
      if (roundMatch) {
        const marketId = decodeURIComponent(roundMatch[1] ?? "");
        const orderSide = (roundMatch[2] ?? "UP").toUpperCase() as OrderSide;
        const row = getTradeRound(db, marketId, orderSide);
        if (!row) {
          notFound(res, config.analyticsCorsOrigin);
          return;
        }
        sendJson(res, 200, { data: serializeTradeRound(row) }, config.analyticsCorsOrigin);
        return;
      }

      if (url.pathname === "/api/v1/events") {
        const limit = parseLimit(url.searchParams.get("limit"), 50, 500);
        const offset = parseOffset(url.searchParams.get("offset"));
        const total = countTradeEvents(db);
        const data = listTradeEvents(db, { limit, offset });
        sendJson(res, 200, { data, meta: { total, limit, offset } }, config.analyticsCorsOrigin);
        return;
      }

      notFound(res, config.analyticsCorsOrigin);
    } catch (err) {
      log.error({ err, path: url.pathname }, "analytics request failed");
      sendJson(res, 500, { error: "internal_error" }, config.analyticsCorsOrigin);
    }
  });
}

export function startAnalyticsServer(params: {
  config: AnalyticsConfig;
  db: Database.Database;
  log: pino.Logger;
}): ReturnType<typeof createServer> {
  const server = createAnalyticsServer(params);
  server.listen(params.config.analyticsPort, params.config.analyticsHost, () => {
    params.log.info(
      {
        host: params.config.analyticsHost,
        port: params.config.analyticsPort,
        dbPath: params.config.dbPath,
        auth: Boolean(params.config.analyticsApiKey),
      },
      "analytics server listening",
    );
  });
  return server;
}
