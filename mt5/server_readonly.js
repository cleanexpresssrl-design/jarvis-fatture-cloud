import http from "node:http";
import { URL } from "node:url";
import crypto from "node:crypto";

const PORT = Number(process.env.PORT || 3000);
const MCP_SECRET = process.env.MCP_SECRET || "";
const AGENT_SECRET = process.env.AGENT_SECRET || "";
const MCP_PATH = MCP_SECRET ? `/mcp/${MCP_SECRET}` : "/mcp";

const state = {
  agent: { lastSeen: null, account: null, positions: [], orders: [] },
  queue: [],
  results: new Map()
};

const tools = [
  { name: "mt5_status", description: "Mostra stato del bridge MT5 e ultimo heartbeat dell'agente locale.", inputSchema: {type:"object",properties:{},additionalProperties:false}, annotations:{readOnlyHint:true,openWorldHint:false}},
  { name: "mt5_account", description: "Restituisce l'ultimo snapshot disponibile del conto MT5: balance, equity, margin, free margin e valuta.", inputSchema:{type:"object",properties:{},additionalProperties:false}, annotations:{readOnlyHint:true,openWorldHint:false}},
  { name: "mt5_positions", description: "Restituisce l'ultimo elenco disponibile delle posizioni aperte sul conto MT5.", inputSchema:{type:"object",properties:{},additionalProperties:false}, annotations:{readOnlyHint:true,openWorldHint:false}},
  { name: "mt5_orders", description: "Restituisce l'ultimo elenco disponibile degli ordini pendenti sul conto MT5.", inputSchema:{type:"object",properties:{},additionalProperties:false}, annotations:{readOnlyHint:true,openWorldHint:false}},
  {
    name: "mt5_request_trade_approval",
    description: "Invia al MetaTrader locale una proposta BUY/SELL. NON esegue da solo: sul Mac compare una conferma locale con tutti i dettagli e l'ordine parte solo se l'utente preme Sì. Usare solo dopo una richiesta esplicita dell'utente per quello specifico ordine.",
    inputSchema:{type:"object",properties:{symbol:{type:"string"},side:{type:"string",enum:["buy","sell"]},volume:{type:"number",exclusiveMinimum:0},stop_loss:{type:"number"},take_profit:{type:"number"},comment:{type:"string"}},required:["symbol","side","volume"],additionalProperties:false},
    annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:false,openWorldHint:false}
  },
  {
    name: "mt5_request_close_approval",
    description: "Invia al MetaTrader locale una proposta di chiusura posizione. NON chiude da solo: la chiusura avviene solo se l'utente approva localmente sul Mac.",
    inputSchema:{type:"object",properties:{ticket:{type:"integer"}},required:["ticket"],additionalProperties:false},
    annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:false,openWorldHint:false}
  },
  {
    name: "mt5_action_status",
    description: "Controlla l'esito di una proposta inviata al MetaTrader locale: pending, approved/executed, rejected o error.",
    inputSchema:{type:"object",properties:{action_id:{type:"string"}},required:["action_id"],additionalProperties:false},
    annotations:{readOnlyHint:true,openWorldHint:false}
  }
];

function send(res,status,body,headers={}){
  res.writeHead(status,{"content-type":"application/json; charset=utf-8",...headers});
  res.end(body===undefined?"":JSON.stringify(body));
}
function sendText(res,status,text){
  res.writeHead(status,{"content-type":"text/plain; charset=utf-8"});
  res.end(text);
}
async function readJson(req){
  let raw="";
  for await(const c of req){raw+=c;if(raw.length>1_000_000)throw new Error("Richiesta troppo grande");}
  return raw?JSON.parse(raw):{};
}
function authorizedAgent(req){return Boolean(AGENT_SECRET)&&req.headers.authorization===`Bearer ${AGENT_SECRET}`;}
function enqueue(type,payload={}){
  const item={id:crypto.randomUUID(),type,payload,status:"queued",createdAt:new Date().toISOString()};
  state.queue.push(item);
  return item;
}
function liveAgent(){return Boolean(state.agent.lastSeen)&&(Date.now()-Date.parse(state.agent.lastSeen)<30000);}
function cleanField(value){return String(value??"").replaceAll("|","/").replaceAll("\n"," ").replaceAll("\r"," ");}
function commandText(item){
  if(!item)return "NONE";
  const p=item.payload||{};
  return [
    cleanField(item.id),cleanField(item.type),cleanField(p.symbol),cleanField(p.side),cleanField(p.volume),
    cleanField(p.stop_loss),cleanField(p.take_profit),cleanField(p.ticket),cleanField(p.comment)
  ].join("|");
}
async function callTool(name,args={}){
  if(name==="mt5_status") return {service:"jarvis-mt5-bridge",agent_online:liveAgent(),last_seen:state.agent.lastSeen,account:state.agent.account,queued_actions:state.queue.filter(x=>x.status==="queued").length};
  if(name==="mt5_account") return {agent_online:liveAgent(),last_seen:state.agent.lastSeen,account:state.agent.account};
  if(name==="mt5_positions") return {agent_online:liveAgent(),last_seen:state.agent.lastSeen,positions:state.agent.positions};
  if(name==="mt5_orders") return {agent_online:liveAgent(),last_seen:state.agent.lastSeen,orders:state.agent.orders};
  if(name==="mt5_request_trade_approval"){
    const symbol=String(args.symbol||"").trim();
    const side=String(args.side||"").toLowerCase();
    const volume=Number(args.volume);
    if(!symbol||!["buy","sell"].includes(side)||!(volume>0))throw new Error("Parametri trade non validi");
    const item=enqueue("trade",{symbol,side,volume,stop_loss:args.stop_loss==null?null:Number(args.stop_loss),take_profit:args.take_profit==null?null:Number(args.take_profit),comment:String(args.comment||"Jarvis ChatGPT")});
    return {action_id:item.id,status:"awaiting_local_approval",message:"Proposta inviata a MetaTrader. L'ordine non verrà eseguito finché l'utente non approva sul Mac.",trade:item.payload};
  }
  if(name==="mt5_request_close_approval"){
    const ticket=Number(args.ticket);
    if(!Number.isInteger(ticket)||ticket<=0)throw new Error("ticket non valido");
    const item=enqueue("close",{ticket});
    return {action_id:item.id,status:"awaiting_local_approval",message:"Richiesta di chiusura inviata a MetaTrader. La posizione resta aperta finché l'utente non approva sul Mac.",close:item.payload};
  }
  if(name==="mt5_action_status"){
    const id=String(args.action_id||"");
    const item=state.queue.find(x=>x.id===id);
    if(!item)throw new Error("action_id non trovato");
    return {action_id:id,status:item.status,result:item.result??null,error:item.error??null,created_at:item.createdAt,completed_at:item.completedAt??null};
  }
  throw new Error(`Strumento sconosciuto: ${name}`);
}
function rpcResult(id,result){return {jsonrpc:"2.0",id,result};}

const server=http.createServer(async(req,res)=>{
  const url=new URL(req.url,`http://${req.headers.host||"localhost"}`);

  if(req.method==="GET"&&url.pathname==="/health")return send(res,200,{ok:true,service:"jarvis-mt5-bridge",agent_online:liveAgent()});

  if(url.pathname==="/agent/heartbeat"&&req.method==="POST"){
    if(!authorizedAgent(req))return send(res,401,{error:"Unauthorized"});
    const body=await readJson(req);
    state.agent.lastSeen=new Date().toISOString();
    if(body.account)state.agent.account=body.account;
    if(Array.isArray(body.positions))state.agent.positions=body.positions;
    if(Array.isArray(body.orders))state.agent.orders=body.orders;
    return send(res,200,{ok:true});
  }

  if(url.pathname==="/agent/next-text"&&req.method==="GET"){
    if(!authorizedAgent(req))return sendText(res,401,"UNAUTHORIZED");
    state.agent.lastSeen=new Date().toISOString();
    const item=state.queue.find(x=>x.status==="queued");
    if(!item)return sendText(res,200,"NONE");
    item.status="awaiting_local_approval";
    item.dispatchedAt=new Date().toISOString();
    return sendText(res,200,commandText(item));
  }

  if(url.pathname==="/agent/result"&&req.method==="POST"){
    if(!authorizedAgent(req))return send(res,401,{error:"Unauthorized"});
    const body=await readJson(req);
    const id=String(body.id||"");
    const item=state.queue.find(x=>x.id===id);
    if(!item)return send(res,404,{error:"Action not found"});
    const outcome=String(body.outcome||"");
    item.status=outcome||"done";
    item.result=body.result??null;
    item.error=body.error??null;
    item.completedAt=new Date().toISOString();
    state.results.set(id,body);
    return send(res,200,{ok:true});
  }

  if(url.pathname!==MCP_PATH)return send(res,404,{error:"Not found"});
  if(req.method==="DELETE")return send(res,200,{ok:true});
  if(req.method!=="POST")return send(res,405,{error:"Use POST"});

  const msg=await readJson(req);
  if(!Object.prototype.hasOwnProperty.call(msg,"id")){res.writeHead(202);return res.end();}
  try{
    if(msg.method==="initialize")return send(res,200,rpcResult(msg.id,{protocolVersion:msg.params?.protocolVersion||"2025-03-26",capabilities:{tools:{listChanged:false}},serverInfo:{name:"Jarvis – MetaTrader 5",version:"0.2.0"},instructions:"Connettore privato MT5. Lettura conto/posizioni/ordini. Le proposte di apertura o chiusura vengono inoltrate al terminale locale e richiedono sempre approvazione dell'utente sul Mac prima dell'esecuzione."}));
    if(msg.method==="ping")return send(res,200,rpcResult(msg.id,{}));
    if(msg.method==="tools/list")return send(res,200,rpcResult(msg.id,{tools}));
    if(msg.method==="tools/call"){
      const out=await callTool(msg.params?.name,msg.params?.arguments||{});
      return send(res,200,rpcResult(msg.id,{content:[{type:"text",text:JSON.stringify(out,null,2)}],structuredContent:out,isError:false}));
    }
    return send(res,200,{jsonrpc:"2.0",id:msg.id,error:{code:-32601,message:"Metodo non supportato"}});
  }catch(e){
    return send(res,200,rpcResult(msg.id,{content:[{type:"text",text:e.message}],structuredContent:{error:{message:e.message}},isError:true}));
  }
});

server.listen(PORT,"0.0.0.0",()=>console.log(`Jarvis MT5 bridge in ascolto sulla porta ${PORT}`));
