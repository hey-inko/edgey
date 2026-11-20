import type { Metadata } from "next";
import Link from "next/link";
import { queryValue, type RouteQuery } from "@/lib/catalogue";

type Props = { searchParams: Promise<RouteQuery> };

// The title never repeats the query: an unmatched code must not reach search engines.
export const metadata: Metadata = {
  title: "Ask us to match a blade",
  robots: { index: false, follow: false },
};

// Placeholder for the compatibility enquiry. The form, staff queue and email
// arrive in a later slice; this page proves the query is carried through.
export default async function EnquiryPage({ searchParams }: Props) {
  const query = queryValue((await searchParams).q);
  return (
    <main id="main-content" tabIndex={-1} className="frame simple-page">
      <p className="kicker">
        <span className="register" aria-hidden="true" />
        Compatibility enquiry
      </p>
      <h1>Ask us to match this blade</h1>
      <dl className="specs">
        <dt>Your search</dt>
        <dd>{query || "No code entered"}</dd>
        <dt>Status</dt>
        <dd>Enquiries are not open yet on this staging build. Nothing has been sent.</dd>
      </dl>
      <div className="empty-actions">
        <Link className="primary" href="/blades">
          Back to the catalogue
        </Link>
      </div>
    </main>
  );
}
