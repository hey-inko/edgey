import "server-only";

import type { Pence } from "@/lib/commerce";

export type BuyerTradeOverview = {
  availableCreditPence: Pence;
  outstandingBalancePence: Pence;
  invoices: readonly {
    orderId: string;
    poReference: string;
  }[];
};

export type BuyerTradeReader = (buyerId: string) => Promise<BuyerTradeOverview | null>;

export const getBuyerTradeOverview: BuyerTradeReader = async () => null;
