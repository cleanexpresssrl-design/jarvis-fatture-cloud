import http from "node:http";
import { URL } from "node:url";
import crypto from "node:crypto";

const PORT = Number(process.env.PORT || 3000);
const MCP_SECRET = process.env.MCP_SECRET || "";
const AGENT_SECRET = process.env.AGENT_SECRET || "";
const MCP_PATH = MCP_SECRET ? `/mcp/${MCP_SECRET}` : "/mcp";

const state = { agent: { lastSeen: null, account: null, positions: [], orders: [] }, queue: [] };

const tools = [
  { name: "mt5_status", description: "Mostra stato del bridge MT5 e ultimo heartbeat.", inputSchema: {type:"object",properties:{},additionalProperties:false}, annotations:{readOnlyHint:true,openWorldHint:false}},
  { name: "mt5_account", description: "Richiede i dati aggiornati del conto MT5.", inputSchema:{type:"object",properties:{},additionalProperties:false}, annotations:{readOnlyHint:true,openWorldHint:false}},
  { name: "mt5_positions", description: "Richiede le posizioni aperte sul conto MT5.", inputSchema:{type:"object",properties:{},additionalProperties:false}, annotations:{readOnlyHint:true,openWorldHint:false}},
  { name: "mt5_orders", description: "Richiede gli ordini pendenti sul conto MT5.", inputSchema:{type:"object",properties:{},additionalProperties:false}, annotations:{readOnlyHint:true,openWorldHint:false}},
  { name: "mt5_prepare_trade", description: "Prepara una bozza di trade da eseguire manualmente in MetaTrader 5; non invia ordini al broker.", inputSchema:{type:"object",properties:{symbol:{type:"string"},side:{type:"string",enum:["buy","sell"]},volume:{type:"number",exclusiveMinimum:0},stop_loss:{type:"number"},take_profit:{type:"number"}},required:["symbol","side","volume"],additionalProperties:false}, annotations:{readOnlyHint:true,openWorldHint:false}}
];

function send(res,status,body){res.writeHead(status,{"content-type":"application/json; charset=utf-8"});res.end(JSON.stringify(body));}
async function readJson(req){let raw="";for await(const c of req){raw+=c;if(raw.length>1_000_000)throw new Error("Richiesta troppo grande");}return raw?JSON.parse(raw):{};}
function queue(type){const id=crypto.randomUUID();state.queue.push({id,type,status:"queued",createdAt:new Date().toISOString()});return id;}
async function callTool(name,args={}){
  if(name==="mt5_status") return {service:"jarvis-mt5-bridge",last_seen:state.agent.lastSeen,account:state.agent.account};
  if(name==="mt5_account") return {queued:true,command_id:queue("account_info")};
  if(name==="mt5_positions") return {queued:true,command_id:queue("positions")};
  if(name==="mt5_orders") return {queued:true,command_id:queue("orders")};
  if(name==="mt5_prepare_trade") return {draft:true,order:{symbol:String(args.symbol||"").toUpperCase(),side:args.side,volume:Number(args.volume),stop_loss:args.stop_loss??null,take_profit:args.take_profit??null},note:"Bozza soltanto: eseguire manualmente in MT5."};
  throw new Error(`Strumento sconosciuto: ${name}`);
}
function rpcResult(id,result){return {jsonrpc:"2.0",id,result};}
const server=http.createServer(async(req,res)=>{
 const url=new URL(req.url,`http://${req.headers.host||"localhost"}`);
 if(req.method==="GET"&&url.pathname==="/health") return send(res,200,{ok:true,service:"jarvis-mt5-bridge"});
 if(url.pathname==="/agent/heartbeat"&&req.method==="POST"){
   if(!AGENT_SECRET||req.headers.authorization!==`Bearer ${AGENT_SECRET}`) return send(res,401,{error:"Unauthorized"});
   const body=await readJson(req); state.agent.lastSeen=new Date().toISOString(); if(body.account)state.agent.account=body.account; if(body.positions)state.agent.positions=body.positions; if(body.orders)state.agent.orders=body.orders; return send(res,200,{ok:true});
 }
 if(url.pathname==="/agent/next"&&req.method==="GET"){
   if(!AGENT_SECRET||req.headers.authorization!==`Bearer ${AGENT_SECRET}`) return send(res,401,{error:"Unauthorized"});
   const item=state.queue.find(x=>x.status==="queued"); if(!item)return send(res,200,{command:null}); item.status="dispatched"; return send(res,200,{command:item});
 }
 if(url.pathname!==MCP_PATH) return send(res,404,{error:"Not found"});
 if(req.method!=="POST") return send(res,405,{error:"Use POST"});
 const msg=await readJson(req); if(!Object.prototype.hasOwnProperty.call(msg,"id")){res.writeHead(202);return res.end();}
 try{
   if(msg.method==="initialize")return send(res,200,rpcResult(msg.id,{protocolVersion:msg.params?.protocolVersion||"2025-03-26",capabilities:{tools:{listChanged:false}},serverInfo:{name:"Jarvis – MetaTrader 5",version:"0.1.0"},instructions:"Connettore MT5 per lettura conto/posizioni/ordini e preparazione di bozze di trade. Non invia ordini al broker."}));
   if(msg.method==="ping")return send(res,200,rpcResult(msg.id,{}));
   if(msg.method==="tools/list")return send(res,200,rpcResult(msg.id,{tools}));
   if(msg.method==="tools/call"){const out=await callTool(msg.params?.name,msg.params?.arguments||{});return send(res,200,rpcResult(msg.id,{content:[{type:"text",text:JSON.stringify(out,null,2)}],structuredContent:out,isError:false}));}
   return send(res,200,{jsonrpc:"2.0",id:msg.id,error:{code:-32601,message:"Metodo non supportato"}});
 }catch(e){return send(res,200,rpcResult(msg.id,{content:[{type:"text",text:e.message}],structuredContent:{error:{message:e.message}},isError:true}));}
});
server.listen(PORT,"0.0.0.0",()=>console.log(`Jarvis MT5 bridge in ascolto sulla porta ${PORT}`));
