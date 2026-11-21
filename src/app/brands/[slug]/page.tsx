import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { brandHref, productHref } from "@/lib/catalogue";
import { getBrandLanding } from "@/lib/catalogue/server";
import { siteUrl } from "@/lib/catalogue/site-url";

type Props = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const landing = await getBrandLanding((await params).slug);
  if (!landing) return { title: "Brand references not found", robots: { index: false } };
  const { brand } = landing;
  return { title: `${brand.name} blade references`, alternates: { canonical: siteUrl(brandHref(brand.slug)) } };
}

export default async function BrandPage({ params }: Props) {
  const landing = await getBrandLanding((await params).slug);
  if (!landing) notFound();
  const { brand, blades } = landing;

  return <main id="main-content" tabIndex={-1} className="frame simple-page">
    <nav className="crumbs" aria-label="Breadcrumb">
      <Link href="/blades">Blade catalogue</Link>
    </nav>
    <p className="kicker"><span className="register" aria-hidden="true" /> Verified references</p>
    <h1>{brand.name} blade references</h1>
    <p className="muted">Check the printed code against these Edgey blade references. Open the blade page to check the machine, tool or holder and any adapter before ordering.</p>
    <div className="table-scroll mt-6" role="region" aria-label="Verified blade references" tabIndex={0}>
      <table className="data-table">
        <caption>Published Edgey blades with verified {brand.name} references</caption>
        <thead><tr><th scope="col">Edgey blade</th><th scope="col">Verified codes</th></tr></thead>
        <tbody>
          {blades.map(({ family, variant, references }) => (
            <tr key={variant.id}>
              <th scope="row">
                <Link className="textlink" href={productHref(family.slug, family.variants.length > 1 ? variant.sku : null)}>
                  {family.name} · {variant.sku}
                </Link>
              </th>
              <td className="code">{[...new Set(references.map(({ code }) => code))].join(", ")}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  </main>;
}
