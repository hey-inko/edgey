import { formatGbp, type BasketLine } from "@/lib/commerce";
import type { QuoteResult } from "@/lib/checkout/types";

type Quote = Extract<QuoteResult, { status: "ok" }>;

export function SelectionLinePrice({ line, vatRate }: { line: BasketLine; vatRate: number }) {
  return (
    <>
      <span className="selection-figures">
        {line.quantity} × {formatGbp(line.unitNetPence)} = {formatGbp(line.lineNetPence)} ex VAT
      </span>
      <span className="fine">{formatGbp(line.lineGrossPence)} inc VAT ({vatRate}%)</span>
      {line.savingPence > 0 && <span className="fine">Quantity saving: {formatGbp(line.savingPence)} ex VAT</span>}
      {line.savingPrompt && <span className="fine">{line.savingPrompt.message}</span>}
    </>
  );
}

export function SelectionTotals({ quote }: { quote: Quote }) {
  if (!quote.basket) return null;
  const { basket } = quote;
  const rate = basket.vatRateBasisPoints / 100;
  const deliveryQuoted = quote.coverage === "covered" || quote.coverage === "unchecked";
  return (
    <>
      <dl className="selection-totals">
        <dt>Subtotal ex VAT</dt>
        <dd>{formatGbp(basket.goodsNetPence)}</dd>
        {deliveryQuoted && (
          <>
            <dt>{quote.coverage === "unchecked" ? "Estimated delivery ex VAT" : "Delivery ex VAT"}</dt>
            <dd>{basket.delivery.netPence ? formatGbp(basket.delivery.netPence) : "Free"}</dd>
          </>
        )}
        <dt>VAT ({rate}%)</dt>
        <dd>{formatGbp(deliveryQuoted ? basket.totalVatPence : basket.goodsVatPence)}</dd>
        <dt className="selection-total">{deliveryQuoted ? "Total inc VAT" : "Goods total inc VAT"}</dt>
        <dd className="selection-total">{formatGbp(deliveryQuoted ? basket.totalGrossPence : basket.goodsGrossPence)}</dd>
      </dl>
      {deliveryQuoted && quote.freeDeliveryMessage && <p className="fine">{quote.freeDeliveryMessage}</p>}
    </>
  );
}

const dateFormat = new Intl.DateTimeFormat("en-GB", {
  weekday: "long", day: "numeric", month: "long", timeZone: "UTC",
});

export function formatDispatchDate(date: string) {
  return dateFormat.format(new Date(date + "T00:00:00Z"));
}

export function DispatchEstimate({ quote, onAccount = false }: { quote: Quote; onAccount?: boolean }) {
  return (
    <>
      <dl className="specs checkout-promise">
        <dt>Dispatch</dt>
        <dd>{quote.dispatchDate ? formatDispatchDate(quote.dispatchDate) : "Estimate unavailable"}</dd>
        <dt>Estimated delivery</dt>
        <dd>
          {quote.estimatedDeliveryDate && (quote.coverage === "unchecked" || quote.coverage === "covered")
            ? formatDispatchDate(quote.estimatedDeliveryDate)
            : quote.coverage === "unsupported" ? "Ask us" : quote.coverage === "invalid" ? "Enter a supported postcode" : "Estimate unavailable"}
        </dd>
        {quote.coverage === "covered" && quote.basket && (
          <>
            <dt>Service</dt>
            <dd>{quote.basket.delivery.quote.serviceName}</dd>
          </>
        )}
      </dl>
      <p className="fine">{onAccount ? "Dates are provisional until your invoice is issued." : "Dates are provisional until payment."}</p>
    </>
  );
}
