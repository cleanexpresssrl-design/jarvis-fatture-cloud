import http from "node:http";
import { URL } from "node:url";
import crypto from "node:crypto";

const PORT = Number(process.env.PORT || 3000);
const MCP_SECRET = process.env.MCP_SECRET || "";
const AGENT_SECRET = process.env.AGENT_SECRET || "";
const MCP_PATH = MCP_SECRET ? `/mcp/${MCP_SECRET}` : "/mcp";

const state = {
  agent: { online: false, lastSeen: null, account: null },
  queue: [],
  results: new Map(),
};

const tools = [
  {
    name: "mt5_status",
    description: "Mostra stato del bridge MT5, ultimo heartbeat dell'agente e riepilogo account se disponibile.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false }
  },
  {
    name: "mt5_account",
    description: "Richiede all'agente MT5 i dati aggiornati del conto: balance, equity, margin, free margin e valuta.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false }
  },
  {
    name: "mt5_positions",
    description: "Richiede l'elenco aggiornato delle posizioni aperte sul conto MT5.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false }
  },
  {
    name: "mt5_orders",
    description: "Richiede l'elenco aggiornato degli ordini pendenti sul conto MT5.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false }
  },
  {
    name: "mt5_prepare_trade",
    description: "Prepara una richiesta di trading senza eseguirla. Restituisce un trade_id da confermare separatamente.",
    inputSchema: {
      type: "object",
      properties: {
        symbol: { type: "string" },
        side: { type: "string", enum: ["buy", "sell"] },
        volume: { type: "number", exclusiveMinimum: 0 },
        stop_loss: { type: "number" },
        take_profit: { type: "number" },
        comment: { type: "string" }
      },
      required: ["symbol", "side", "volume"],
      additionalProperties: false
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  },
  {
    name: "mt5_confirm_trade",
    description: "Esegue sul conto reale una richiesta preparata. Richiede conferma testuale esatta prima dell'invio all'agente MT5.",
    inputSchema: {
      type: "object",
      properties: {
        trade_id: { type: "string" },
        confirmation_text: { type: "string", description: "Deve essere esattamente CONFERMO TRADE" }
      },
      required: ["trade_id", "confirmation_text"],
      additionalProperties: false
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
  },
  {
    name: "mt5_prepare_close",
    description: "Prepara la chiusura di una posizione aperta senza eseguirla.",
    inputSchema: {
      type: "object",
      properties: { ticket: { type: "integer" }, volume: { type: "number", exclusiveMinimum: 0 } },
      required: ["ticket"],
      additionalProperties: false
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  },
  {
    name: "mt5_confirm_close",
    description: "Chiude una posizione preparata. Richiede conferma testuale esatta.",
    inputSchema: {
      type: "object",
      properties: {
        close_id: { type: "string" },
        confirmation_text: { type: "string", description: "Deve essere esattamente CONFERMO CHIUSURA" }
      },
      required: ["close_id", "confirmation_text"],
      additionalProperties: false
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
  }
];

function send(res, status, body, headers = {}) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", ...headers });
  res.end(body === undefined ? "" : JSON.stringify(body));
}

async function readJson(req) {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 1_000_000) throw new Error("Richiesta troppo grande");
  }
  return raw ? JSON.parse(raw) : {};
}

function command(type, payload = {}, requiresConfirmation = false) {
  const id = crypto.randomUUID();
  const item = { id, type, payload, status: requiresConfirmation ? "prepared" : "queued", createdAt: new Date().toISOString() };
  state.queue.push(item);
  return item;
}

function findPrepared(id, type) {
  const item = state.queue.find(x => x.id === id && x.type === type && x.status === "prepared");
  if (!item) throw new Error("Richiesta preparata non trovata o già utilizzata");
  return item;
}

async function callTool(name, args = {}) {
  if (name === "mt5_status") {
    return {
      service: "jarvis-mt5-bridge",
      agent_online: state.agent.online && state.agent.lastSeen && (Date.now() - Date.parse(state.agent.lastSeen) < 30000),
      last_seen: state.agent.lastSeen,
      account: state.agent.account,
      queued_commands: state.queue.filter(x => x.status === "queued").length
    };
  }
  if (name === "mt5_account") return { queued: true, command: command("account_info") };
  if (name === "mt5_positions") return { queued: true, command: command("positions") };
  if (name === "mt5_orders") return { queued: true, command: command("orders") };

  if (name === "mt5_prepare_trade") {
    if (!args.symbol || !["buy", "sell"].includes(args.side) || !(Number(args.volume) > 0)) throw new Error("Parametri trade non validi");
    const item = command("trade", {
      symbol: String(args.symbol).toUpperCase(),
      side: args.side,
      volume: Number(args.volume),
      stop_loss: args.stop_loss == null ? null : Number(args.stop_loss),
      take_profit: args.take_profit == null ? null : Number(args.take_profit),
      comment: args.comment || "Jarvis ChatGPT"
    }, true);
    return { prepared: true, trade_id: item.id, trade: item.payload, confirmation_required: "CONFERMO TRADE" };
  }

  if (name === "mt5_confirm_trade") {
    if (args.confirmation_text !== "CONFERMO TRADE") throw new Error("Conferma mancante o non valida");
    const item = findPrepared(args.trade_id, "trade");
    item.status = "queued";
    item.confirmedAt = new Date().toISOString();
    return { queued: true, trade_id: item.id, trade: item.payload };
  }

  if (name === "mt5_prepare_close") {
    if (!Number.isInteger(Number(args.ticket))) throw new Error("ticket non valido");
    const item = command("close", { ticket: Number(args.ticket), volume: args.volume == null ? null : Number(args.volume) }, true);
    return { prepared: true, close_id: item.id, close: item.payload, confirmation_required: "CONFERMO CHIUSURA" };
  }

  if (name === "mt5_confirm_close") {
    if (args.confirmation_text !== "CONFERMO CHIUSURA") throw new Error("Conferma mancante o non valida");
    const item = findPrepared(args.close_id, "close");
    item.status = "queued";
    item.confirmedAt = new Date().toISOString();
    return { queued: true, close_id: item.id, close: item.payload };
  }

  throw new Error(`Strumento sconosciuto: ${name}`);
}

function rpcResult(id, result) { return { jsonrpc: "2.0", id, result }; }
function rpcError(id, code, message) { return { jsonrpc: "2.0", id: id ?? null, error: { code, message } }; }

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  if (req.method === "GET" && url.pathname === "/health") {
    return send(res, 200, { ok: true, service: "jarvis-mt5-bridge", agentLastSeen: state.agent.lastSeen });
  }

  if (url.pathname === "/agent/heartbeat" && req.method === "POST") {
    if (!AGENT_SECRET || req.headers.authorization !== `Bearer ${AGENT_SECRET}`) return send(res, 401, { error: "Unauthorized" });
    const body = await readJson(req);
    state.agent.online = true;
    state.agent.lastSeen = new Date().toISOString();
    if (body.account) state.agent.account = body.account;
    return send(res, 200, { ok: true });
  }

  if (url.pathname === "/agent/next" && req.method === "GET") {
    if (!AGENT_SECRET || req.headers.authorization !== `Bearer ${AGENT_SECRET}`) return send(res, 401, { error: "Unauthorized" });
    state.agent.online = true;
    state.agent.lastSeen = new Date().toISOString();
    const item = state.queue.find(x => x.status === "queued");
    if (!item) return send(res, 200, { command: null });
    item.status = "dispatched";
    item.dispatchedAt = new Date().toISOString();
    return send(res, 200, { command: item });
  }

  if (url.pathname === "/agent/result" && req.method === "POST") {
    if (!AGENT_SECRET || req.headers.authorization !== `Bearer ${AGENT_SECRET}`) return send(res, 401, { error: "Unauthorized" });
    const body = await readJson(req);
    if (!body.id) return send(res, 400, { error: "id mancante" });
    const item = state.queue.find(x => x.id === body.id);
    if (item) {
      item.status = body.ok === false ? "error" : "done";
      item.completedAt = new Date().toISOString();
      item.result = body.result ?? null;
      item.error = body.error ?? null;
    }
    state.results.set(body.id, body);
    return send(res, 200, { ok: true });
  }

  if (url.pathname !== MCP_PATH) return send(res, 404, { error: "Not found" });
  if (req.method === "GET") return send(res, 405, { error: "Use POST" });
  if (req.method === "DELETE") return send(res, 200, { ok: true });
  if (req.method !== "POST") return send(res, 405, { error: "Method not allowed" });

  let message;
  try { message = await readJson(req); }
  catch (error) { return send(res, 400, rpcError(null, -32700, error.message)); }

  if (!Object.prototype.hasOwnProperty.call(message, "id")) {
    res.writeHead(202);
    return res.end();
  }

  try {
    if (message.method === "initialize") {
      return send(res, 200, rpcResult(message.id, {
        protocolVersion: message.params?.protocolVersion || "2025-03-26",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "Jarvis – MetaTrader 5", version: "0.1.0" },
        instructions: "Connettore privato MT5. Letture dirette. Le operazioni reali vengono prima preparate e poi richiedono una conferma esplicita separata prima di essere inviate all'agente MT5."
      }));
    }
    if (message.method === "ping") return send(res, 200, rpcResult(message.id, {}));
    if (message.method === "tools/list") return send(res, 200, rpcResult(message.id, { tools }));
    if (message.method === "tools/call") {
      const output = await callTool(message.params?.name, message.params?.arguments || {});
      return send(res, 200, rpcResult(message.id, {
        content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
        structuredContent: output,
        isError: false
      }));
    }
    return send(res, 200, rpcError(message.id, -32601, `Metodo non supportato: ${message.method}`));
  } catch (error) {
    return send(res, 200, rpcResult(message.id, {
      content: [{ type: "text", text: error.message }],
      structuredContent: { error: { message: error.message } },
      isError: true
    }));
  }
});

server.listen(PORT, "0.0.0.0", () => console.log(`Jarvis MT5 bridge in ascolto sulla porta ${PORT}`));
