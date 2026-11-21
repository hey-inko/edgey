import { staffSession } from "@/lib/admin/auth";
import { stagingPhotoObject } from "@/lib/catalogue/media";
import { serviceClient } from "@/lib/supabase/service";

export const dynamic = "force-dynamic";

const headers = {
  "Cache-Control": "private, no-store",
  "Cross-Origin-Resource-Policy": "same-origin",
  "X-Content-Type-Options": "nosniff",
};

function notFound() {
  return new Response(null, { status: 404, headers });
}

export async function GET(request: Request, { params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  const object = stagingPhotoObject(name, request);
  if (!object) return notFound();
  try {
    const staff = await staffSession();
    if (!staff?.roles.includes("catalogue")) return notFound();
    const db = serviceClient();
    const variant = await db.from("variants").select("publication_status").eq("sku", object.sku).maybeSingle();
    if (variant.error || variant.data?.publication_status !== "draft") return notFound();
    const { data, error } = await db.storage.from("catalogue-review-photos").download(object.path);
    if (error || !data) return notFound();
    return new Response(data, { headers: { ...headers, "Content-Type": "image/webp" } });
  } catch {
    return notFound();
  }
}
