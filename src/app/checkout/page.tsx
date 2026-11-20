import type { Metadata } from "next";
import { CheckoutReview } from "@/components/checkout-review";

export const metadata: Metadata = {
  title: "Checkout",
  robots: { index: false, follow: false },
};

export default function CheckoutPage() {
  return (
    <main id="main-content" tabIndex={-1} className="frame checkout">
      <div className="checkout-heading">
        <p className="kicker"><span className="register" aria-hidden="true" /> Trade orders</p>
        <h1>Checkout</h1>
        <p className="muted">Review your selection and tell us where to deliver it.</p>
      </div>
      <CheckoutReview />
    </main>
  );
}
