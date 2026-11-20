import Link from "next/link";
import { Wordmark } from "./wordmark";

export function SiteFooter() {
  return (
    <footer>
      <div className="frame footer-proof">
        <Link href="#top" className="proof-wordmark" aria-label="Edgey back to top">
          <Wordmark />
        </Link>
      </div>
      <div className="frame foot-inner">
        <p>Staging catalogue · Test data · UK trade pricing ex VAT</p>
        <nav aria-label="Footer" className="ml-auto flex flex-wrap gap-x-4 gap-y-2">
          <Link className="textlink" href="/enquiry">Enquiries</Link>
          <Link className="textlink" href="/sample-pack">Two-blade trial</Link>
          <Link className="textlink" href="/trade">Trade accounts</Link>
          <Link className="textlink" href="#top">Back to top</Link>
        </nav>
      </div>
    </footer>
  );
}
