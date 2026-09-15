import http from "node:http";
import { URL } from "node:url";

const PORT = Number(process.env.PORT || 3000);
const FIC_API = (process.env.FIC_API || "https://api-v2.fattureincloud.it").replace(/\/+$/, "");
const FIC_TOKEN = process.env.FIC_TOKEN || "";
const MCP_SECRET = process.env.MCP_SECRET || "";
const MCP_PATH = MCP_SECRET ? `/mcp/${MCP_SECRET}` : "/mcp";

const ISSUED_DOCUMENT_TYPES = [
  "invoice",
  "quote",
  "proforma",
  "receipt",
  "delivery_note",
  "credit_note",
  "order",
  "work_report",
  "supplier_order",
  "self_own_invoice",
  "self_supplier_invoice"
];

const tools = [
  {
    name: "list_companies",
    description: "Elenca le aziende Fatture in Cloud autorizzate. Usalo per individuare il company_id corretto.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false }
  },
  {
    name: "list_issued_documents",
    description: "Cerca fatture e altri documenti emessi. Può filtrare per cliente, stato di pagamento e intervallo di date.",
    inputSchema: {
      type: "object",
      properties: {
        company_id: { type: "integer", description: "ID azienda; se omesso usa la prima azienda autorizzata." },
        document_type: {
          type: "string",
          enum: ISSUED_DOCUMENT_TYPES,
          default: "invoice",
          description: "Tipo di documento emesso. Se omesso usa invoice (fattura)."
        },
        customer_name: { type: "string", description: "Nome o parte del nome del cliente." },
        payment_status: { type: "string", enum: ["paid", "not_paid", "reversed"], description: "Stato della rata/pagamento." },
        date_from: { type: "string", format: "date", description: "Data iniziale YYYY-MM-DD." },
        date_to: { type: "string", format: "date", description: "Data finale YYYY-MM-DD." },
        page: { type: "integer", minimum: 1, default: 1 },
        per_page: { type: "integer", minimum: 1, maximum: 50, default: 20 }
      },
      additionalProperties: false
    },
    annotations: { readOnlyHint: true, openWorldHint: false }
  },
  {
    name: "get_issued_document",
    description: "Recupera i dettagli completi di una fattura o documento emesso, comprese rate e pagamenti.",
    inputSchema: {
      type: "object",
      properties: {
        company_id: { type: "integer" },
        document_id: { type: "integer" }
      },
      required: ["document_id"],
      additionalProperties: false
    },
    annotations: { readOnlyHint: true, openWorldHint: false }
  },
  {
    name: "list_payment_accounts",
    description: "Elenca i conti di saldo utilizzabili per registrare l'incasso di una fattura.",
    inputSchema: {
      type: "object",
      properties: { company_id: { type: "integer" } },
      additionalProperties: false
    },
    annotations: { readOnlyHint: true, openWorldHint: false }
  },
  {
    name: "mark_payment_paid",
    description: "Segna una specifica rata di una fattura come pagata. Prima mostra i dati all'utente e chiedi conferma esplicita. Non chiamare senza confirmation_text esatto.",
    inputSchema: {
      type: "object",
      properties: {
        company_id: { type: "integer" },
        document_id: { type: "integer", description: "ID della fattura." },
        payment_id: { type: "integer", description: "ID della rata da saldare." },
        payment_account_id: { type: "integer", description: "ID del conto sul quale registrare l'incasso." },
        paid_date: { type: "string", format: "date", description: "Data dell'incasso YYYY-MM-DD." },
        confirmation_text: { type: "string", description: "Deve essere esattamente CONFERMO PAGAMENTO." }
      },
      required: ["document_id", "payment_id", "payment_account_id", "paid_date", "confirmation_text"],
      additionalProperties: false
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
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

async function fic(path, options = {}) {
  if (!FIC_TOKEN) throw new Error("FIC_TOKEN non configurato su Render");
  const response = await fetch(`${FIC_API}${path}`, {
    ...options,
    headers: {
      accept: "application/json",
      authorization: `Bearer ${FIC_TOKEN}`,
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...(options.headers || {})
    }
  });
  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!response.ok) {
    const detail = data?.error?.message || data?.message || text || response.statusText;
    const error = new Error(`Fatture in Cloud ${response.status}: ${detail}`);
    error.status = response.status;
    error.details = data;
    throw error;
  }
  return data;
}

async function companyId(requested) {
  if (requested) return requested;
  const result = await fic("/user/companies");
  const companies = result?.data?.companies || [];
  if (!companies.length) throw new Error("Nessuna azienda autorizzata nel token");
  return companies[0].id;
}

function escapeQueryValue(value) {
  return String(value).replaceAll("\\", "\\\\").replaceAll("'", "\\'");
}

function validateDate(value, fieldName) {
  if (value === undefined) return;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value))) {
    throw new Error(`${fieldName} deve essere nel formato YYYY-MM-DD`);
  }
}

function summarizeDocument(d) {
  const payments = Array.isArray(d.payments_list) ? d.payments_list : [];
  return {
    id: d.id,
    type: d.type,
    number: `${d.number ?? ""}${d.numeration ?? ""}`,
    date: d.date,
    customer: d.entity?.name,
    amount_net: d.amount_net,
    amount_vat: d.amount_vat,
    amount_gross: d.amount_gross,
    next_due_date: d.next_due_date,
    payments: payments.map(p => ({
      id: p.id,
      due_date: p.due_date,
      amount: p.amount,
      status: p.status,
      paid_date: p.paid_date,
      payment_account: p.payment_account ? { id: p.payment_account.id, name: p.payment_account.name } : null
    }))
  };
}

async function callTool(name, args = {}) {
  if (name === "list_companies") {
    const result = await fic("/user/companies");
    const companies = result?.data?.companies || [];
    return { companies, count: companies.length };
  }

  if (name === "list_issued_documents") {
    const cid = await companyId(args.company_id);
    const documentType = args.document_type || "invoice";
    if (!ISSUED_DOCUMENT_TYPES.includes(documentType)) {
      throw new Error(`document_type non valido: ${documentType}`);
    }
    validateDate(args.date_from, "date_from");
    validateDate(args.date_to, "date_to");
    if (args.date_from && args.date_to && args.date_from > args.date_to) {
      throw new Error("date_from non può essere successiva a date_to");
    }
    const params = new URLSearchParams({
      type: documentType,
      page: String(args.page || 1),
      per_page: String(Math.min(args.per_page || 20, 50)),
      sort: "-date,-number"
    });
    const filters = [];
    if (args.customer_name) filters.push(`entity.name like '%${escapeQueryValue(args.customer_name)}%'`);
    if (args.date_from) filters.push(`date >= '${escapeQueryValue(args.date_from)}'`);
    if (args.date_to) filters.push(`date <= '${escapeQueryValue(args.date_to)}'`);
    if (filters.length) params.set("q", filters.join(" and "));
    const result = await fic(`/c/${cid}/issued_documents?${params}`);
    let docs = (result?.data || []).map(summarizeDocument);
    if (args.payment_status) docs = docs.filter(d => d.payments.some(p => p.status === args.payment_status));
    return { company_id: cid, document_type: documentType, documents: docs, pagination: result?.meta || null };
  }

  if (name === "get_issued_document") {
    const cid = await companyId(args.company_id);
    const result = await fic(`/c/${cid}/issued_documents/${args.document_id}`);
    return { company_id: cid, document: result?.data || result };
  }

  if (name === "list_payment_accounts") {
    const cid = await companyId(args.company_id);
    const result = await fic(`/c/${cid}/settings/payment_accounts`);
    return { company_id: cid, accounts: result?.data || [] };
  }

  if (name === "mark_payment_paid") {
    if (args.confirmation_text !== "CONFERMO PAGAMENTO") {
      throw new Error("Conferma mancante: chiedi all'utente di confermare esplicitamente l'operazione");
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(args.paid_date)) throw new Error("paid_date deve essere YYYY-MM-DD");
    const cid = await companyId(args.company_id);
    const current = await fic(`/c/${cid}/issued_documents/${args.document_id}`);
    const document = current?.data;
    if (!document) throw new Error("Documento non trovato");
    const payments = Array.isArray(document.payments_list) ? document.payments_list : [];
    const payment = payments.find(p => Number(p.id) === Number(args.payment_id));
    if (!payment) throw new Error("Rata non trovata nella fattura");
    if (payment.status === "paid" && payment.paid_date === args.paid_date && Number(payment.payment_account?.id) === Number(args.payment_account_id)) {
      return { already_paid: true, company_id: cid, document: summarizeDocument(document) };
    }
    payment.status = "paid";
    payment.paid_date = args.paid_date;
    payment.payment_account = { id: Number(args.payment_account_id) };
    const updated = await fic(`/c/${cid}/issued_documents/${args.document_id}`, {
      method: "PUT",
      body: JSON.stringify({ data: document })
    });
    return {
      success: true,
      message: "Pagamento registrato in Fatture in Cloud",
      company_id: cid,
      document: summarizeDocument(updated?.data || document)
    };
  }

  throw new Error(`Strumento sconosciuto: ${name}`);
}

function rpcResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(id, code, message) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  if (req.method === "GET" && url.pathname === "/health") {
    return send(res, 200, { ok: true, service: "jarvis-fatture-cloud", configured: Boolean(FIC_TOKEN) });
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
        serverInfo: { name: "Jarvis – Fatture in Cloud", version: "1.0.0" },
        instructions: "Connettore privato Clean Express. Le letture possono essere eseguite direttamente. Prima di registrare un pagamento mostra fattura, cliente, importo, data e conto, poi richiedi conferma esplicita all'utente."
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
    const status = Number.isInteger(error.status) ? error.status : null;
    return send(res, 200, rpcResult(message.id, {
      content: [{ type: "text", text: error.message }],
      structuredContent: {
        error: {
          message: error.message,
          status,
          details: error.details || null
        }
      },
      isError: true
    }));
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Jarvis Fatture Cloud in ascolto sulla porta ${PORT}`);
});
