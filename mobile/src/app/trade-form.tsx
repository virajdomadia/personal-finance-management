import { useLocalSearchParams } from "expo-router";

import { CryptoTradeScreen } from "@/components/trade-forms/crypto-trade-form";
import { FundTradeScreen } from "@/components/trade-forms/fund-trade-form";
import { StockTradeScreen } from "@/components/trade-forms/stock-trade-form";

// One screen for every buy, sell and existing holding: `kind` picks the stock, fund or coin form.
// Each kind keeps its own fields and rules. A stock is the default, so older links still open.
//
// Params: kind (stock | mutual_fund | crypto), id (a trade to edit), mode (buy | sell | opening, and
// sip for funds), the holding's stockId / fundId / coinId, accountId, sipId and date, and new=1 when
// Add investment opened it for a first purchase.
export default function TradeFormScreen() {
  const { kind } = useLocalSearchParams<{ kind?: string }>();
  if (kind === "mutual_fund") return <FundTradeScreen />;
  if (kind === "crypto") return <CryptoTradeScreen />;
  return <StockTradeScreen />;
}
