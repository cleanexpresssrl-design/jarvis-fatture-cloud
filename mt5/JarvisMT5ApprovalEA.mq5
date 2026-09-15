#property strict
#property version   "0.1.0"
#property description "Jarvis MT5 approval EA: polls bridge, shows local confirmation, then executes only after user approval."

input string BridgeBaseUrl = "https://jarvis-mt5-bridge.onrender.com";
input string AgentSecret = "";
input int PollSeconds = 3;
input int MaxSlippagePoints = 30;

#include <Trade/Trade.mqh>
CTrade trade;

datetime last_poll = 0;

string Trim(string s)
{
   StringTrimLeft(s);
   StringTrimRight(s);
   return s;
}

bool HttpGetText(string path, string &response)
{
   string headers = "Authorization: Bearer " + AgentSecret + "\r\n";
   char result[];
   string result_headers;
   ResetLastError();
   int code = WebRequest("GET", BridgeBaseUrl + path, headers, 5000, NULL, result, result_headers);
   if(code == -1)
   {
      Print("WebRequest GET failed: ", GetLastError());
      return false;
   }
   response = CharArrayToString(result, 0, -1, CP_UTF8);
   return (code >= 200 && code < 300);
}

bool HttpPostJson(string path, string json)
{
   string headers = "Authorization: Bearer " + AgentSecret + "\r\nContent-Type: application/json\r\n";
   char data[], result[];
   string result_headers;
   StringToCharArray(json, data, 0, WHOLE_ARRAY, CP_UTF8);
   ResetLastError();
   int code = WebRequest("POST", BridgeBaseUrl + path, headers, 5000, data, result, result_headers);
   if(code == -1)
   {
      Print("WebRequest POST failed: ", GetLastError());
      return false;
   }
   return (code >= 200 && code < 300);
}

string JsonEscape(string s)
{
   StringReplace(s, "\\", "\\\\");
   StringReplace(s, "\"", "\\\"");
   StringReplace(s, "\r", " ");
   StringReplace(s, "\n", " ");
   return s;
}

void SendHeartbeat()
{
   double balance = AccountInfoDouble(ACCOUNT_BALANCE);
   double equity = AccountInfoDouble(ACCOUNT_EQUITY);
   double margin = AccountInfoDouble(ACCOUNT_MARGIN);
   double free_margin = AccountInfoDouble(ACCOUNT_MARGIN_FREE);
   string currency = AccountInfoString(ACCOUNT_CURRENCY);

   string positions_json = "[";
   int pc = PositionsTotal();
   for(int i=0; i<pc; i++)
   {
      ulong ticket = PositionGetTicket(i);
      if(ticket == 0) continue;
      string symbol = PositionGetString(POSITION_SYMBOL);
      long type = PositionGetInteger(POSITION_TYPE);
      double volume = PositionGetDouble(POSITION_VOLUME);
      double price_open = PositionGetDouble(POSITION_PRICE_OPEN);
      double sl = PositionGetDouble(POSITION_SL);
      double tp = PositionGetDouble(POSITION_TP);
      double profit = PositionGetDouble(POSITION_PROFIT);
      if(StringLen(positions_json) > 1) positions_json += ",";
      positions_json += StringFormat("{\"ticket\":%I64u,\"symbol\":\"%s\",\"side\":\"%s\",\"volume\":%.8f,\"price_open\":%.10f,\"sl\":%.10f,\"tp\":%.10f,\"profit\":%.2f}",
         ticket, JsonEscape(symbol), type==POSITION_TYPE_BUY?"buy":"sell", volume, price_open, sl, tp, profit);
   }
   positions_json += "]";

   string orders_json = "[";
   int oc = OrdersTotal();
   for(int j=0; j<oc; j++)
   {
      ulong ticket = OrderGetTicket(j);
      if(ticket == 0) continue;
      string symbol = OrderGetString(ORDER_SYMBOL);
      long type = OrderGetInteger(ORDER_TYPE);
      double volume = OrderGetDouble(ORDER_VOLUME_CURRENT);
      double price = OrderGetDouble(ORDER_PRICE_OPEN);
      if(StringLen(orders_json) > 1) orders_json += ",";
      orders_json += StringFormat("{\"ticket\":%I64u,\"symbol\":\"%s\",\"type\":%d,\"volume\":%.8f,\"price\":%.10f}",
         ticket, JsonEscape(symbol), (int)type, volume, price);
   }
   orders_json += "]";

   string json = StringFormat(
      "{\"account\":{\"login\":%I64d,\"server\":\"%s\",\"balance\":%.2f,\"equity\":%.2f,\"margin\":%.2f,\"free_margin\":%.2f,\"currency\":\"%s\"},\"positions\":%s,\"orders\":%s}",
      (long)AccountInfoInteger(ACCOUNT_LOGIN), JsonEscape(AccountInfoString(ACCOUNT_SERVER)), balance, equity, margin, free_margin, JsonEscape(currency), positions_json, orders_json);
   HttpPostJson("/agent/heartbeat", json);
}

bool ParseCommand(string line, string &id, string &type, string &symbol, string &side, double &volume, double &sl, double &tp, long &ticket, string &comment)
{
   string parts[];
   int n = StringSplit(Trim(line), '|', parts);
   if(n < 9) return false;
   id = parts[0];
   type = parts[1];
   symbol = parts[2];
   side = parts[3];
   volume = StringToDouble(parts[4]);
   sl = StringLen(parts[5]) ? StringToDouble(parts[5]) : 0.0;
   tp = StringLen(parts[6]) ? StringToDouble(parts[6]) : 0.0;
   ticket = StringLen(parts[7]) ? (long)StringToInteger(parts[7]) : 0;
   comment = parts[8];
   return true;
}

void ReportResult(string id, string outcome, string result_text, string error_text="")
{
   string json = StringFormat("{\"id\":\"%s\",\"outcome\":\"%s\",\"result\":\"%s\",\"error\":\"%s\"}",
      JsonEscape(id), JsonEscape(outcome), JsonEscape(result_text), JsonEscape(error_text));
   HttpPostJson("/agent/result", json);
}

void HandleTrade(string id, string symbol, string side, double volume, double sl, double tp, string comment)
{
   if(!SymbolSelect(symbol, true))
   {
      ReportResult(id, "error", "", "Symbol not available");
      return;
   }

   int digits = (int)SymbolInfoInteger(symbol, SYMBOL_DIGITS);
   string msg = StringFormat("Confermi questo ordine reale?\n\n%s %s\nVolume: %.4f\nSL: %s\nTP: %s\n\nL'ordine verra inviato subito al broker solo se premi Sì.",
      StringToUpper(side), symbol, volume,
      sl>0?DoubleToString(sl,digits):"nessuno",
      tp>0?DoubleToString(tp,digits):"nessuno");

   int ans = MessageBox(msg, "Jarvis MT5 - Conferma ordine", MB_YESNO|MB_ICONWARNING);
   if(ans != IDYES)
   {
      ReportResult(id, "rejected", "Ordine rifiutato localmente");
      return;
   }

   trade.SetDeviationInPoints(MaxSlippagePoints);
   bool ok = false;
   if(side == "buy") ok = trade.Buy(volume, symbol, 0.0, sl, tp, comment);
   else if(side == "sell") ok = trade.Sell(volume, symbol, 0.0, sl, tp, comment);

   if(ok)
      ReportResult(id, "executed", StringFormat("Order sent. Deal=%I64u Order=%I64u Retcode=%u", trade.ResultDeal(), trade.ResultOrder(), trade.ResultRetcode()));
   else
      ReportResult(id, "error", "", StringFormat("Trade failed. Retcode=%u %s", trade.ResultRetcode(), trade.ResultRetcodeDescription()));
}

void HandleClose(string id, long ticket)
{
   if(ticket <= 0 || !PositionSelectByTicket((ulong)ticket))
   {
      ReportResult(id, "error", "", "Position not found");
      return;
   }
   string symbol = PositionGetString(POSITION_SYMBOL);
   double volume = PositionGetDouble(POSITION_VOLUME);
   double profit = PositionGetDouble(POSITION_PROFIT);
   string msg = StringFormat("Confermi la CHIUSURA reale della posizione?\n\nTicket: %I64d\n%s\nVolume: %.4f\nP/L attuale: %.2f\n\nLa posizione verra chiusa subito solo se premi Sì.", ticket, symbol, volume, profit);
   int ans = MessageBox(msg, "Jarvis MT5 - Conferma chiusura", MB_YESNO|MB_ICONWARNING);
   if(ans != IDYES)
   {
      ReportResult(id, "rejected", "Chiusura rifiutata localmente");
      return;
   }
   trade.SetDeviationInPoints(MaxSlippagePoints);
   bool ok = trade.PositionClose((ulong)ticket);
   if(ok)
      ReportResult(id, "executed", StringFormat("Position closed. Ticket=%I64d Retcode=%u", ticket, trade.ResultRetcode()));
   else
      ReportResult(id, "error", "", StringFormat("Close failed. Retcode=%u %s", trade.ResultRetcode(), trade.ResultRetcodeDescription()));
}

void Poll()
{
   SendHeartbeat();
   string response;
   if(!HttpGetText("/agent/next-text", response)) return;
   response = Trim(response);
   if(response == "" || response == "NONE") return;

   string id,type,symbol,side,comment;
   double volume,sl,tp;
   long ticket;
   if(!ParseCommand(response,id,type,symbol,side,volume,sl,tp,ticket,comment)) return;

   if(type == "trade") HandleTrade(id,symbol,side,volume,sl,tp,comment);
   else if(type == "close") HandleClose(id,ticket);
}

int OnInit()
{
   if(StringLen(AgentSecret) < 8)
   {
      Print("AgentSecret not configured");
      return INIT_PARAMETERS_INCORRECT;
   }
   EventSetTimer(MathMax(PollSeconds,1));
   trade.SetAsyncMode(false);
   Print("Jarvis MT5 Approval EA started");
   return INIT_SUCCEEDED;
}

void OnDeinit(const int reason)
{
   EventKillTimer();
}

void OnTimer()
{
   Poll();
}
