import { randomUUID } from "node:crypto";
import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { expect, test, type Page } from "@playwright/test";
import { createLocalAdminUser, localAdminClient } from "../../scripts/seed-admin";
import { signInStaff } from "./admin-fixtures";

const privatePaths = [
  "/admin", "/admin/warehouse", "/admin/warehouse/8028e331-bde6-4d32-97c4-7fcf1bed9190",
  "/admin/warehouse/8028e331-bde6-4d32-97c4-7fcf1bed9190/print", "/admin/stock",
  "/admin/stock/8028e331-bde6-4d32-97c4-7fcf1bed9190", "/admin/catalogue",
  "/admin/catalogue/8028e331-bde6-4d32-97c4-7fcf1bed9190", "/admin/finance", "/admin/requests",
];

async function setBuyerSession(page: Page, credentials: { email: string; password: string }, baseURL: string) {
  const jar = new Map<string, { name: string; value: string; options: CookieOptions }>();
  const client = createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    cookieOptions: { name: "edgey-auth" },
    cookies: {
      getAll: () => [...jar.values()],
      setAll: (list) => { for (const cookie of list) jar.set(cookie.name, cookie); },
    },
  });
  const auth = await client.auth.signInWithPassword(credentials);
  expect(auth.error).toBeNull();
  const verified = await client.auth.getUser();
  expect(verified.data.user?.email).toBe(credentials.email);
  await page.context().addCookies([...jar.values()].map(({ name, value }) => ({
    name, value, url: baseURL, httpOnly: true, sameSite: "Lax",
  })));
}

test("anonymous users and signed-in buyers cannot reach any staff page", async ({ page, baseURL }) => {
  const checkAll = async () => {
    for (const path of privatePaths) {
      await page.goto(path);
      await expect(page).toHaveURL(/\/admin\/sign-in$/);
      await expect(page.getByRole("heading", { name: "Staff sign-in" })).toBeVisible();
      await expect(page.getByRole("navigation", { name: "Staff areas" })).toHaveCount(0);
    }
  };
  await checkAll();
  const buyer = await createLocalAdminUser("buyer");
  await page.getByLabel("Work email").fill(buyer.email);
  await page.getByLabel("Password").fill(buyer.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Could not sign in" })).toBeVisible();
  await setBuyerSession(page, { email: buyer.email, password: buyer.password }, baseURL!);
  await checkAll();
});

test("a stale finance replay form cannot act after switching to a warehouse session", async ({ browser, page, baseURL }) => {
  const db = localAdminClient();
  const eventId = `evt_${randomUUID().replaceAll("-", "")}`;
  const event = await db.rpc("record_provider_event", {
    p_provider: "stripe", p_event_id: eventId, p_event_type: "fixture.failed", p_payload: { fixture: true },
  });
  if (event.error) throw event.error;
  const failed = await db.rpc("mark_provider_event", {
    p_provider: "stripe", p_event_id: eventId, p_state: "failed", p_error: "Fixture did not process",
  });
  if (failed.error) throw failed.error;

  await signInStaff(page, await createLocalAdminUser("finance"));
  await page.goto("/admin/finance");
  const replay = page.getByRole("row").filter({ hasText: eventId }).getByRole("button", { name: "Reprocess event" });
  await expect(replay).toBeVisible();

  const warehouseContext = await browser.newContext({ baseURL });
  try {
    const warehousePage = await warehouseContext.newPage();
    await signInStaff(warehousePage, await createLocalAdminUser("warehouse"));
    for (const path of ["/admin/finance", "/admin/catalogue"]) {
      await warehousePage.goto(path);
      await expect(warehousePage).toHaveURL(/\/admin$/);
    }
    await page.context().clearCookies();
    await page.context().addCookies(await warehouseContext.cookies());
    await replay.click();
    await expect(page).toHaveURL(/\/admin$/);
    const { data } = await db.from("provider_events").select("state,last_error").eq("event_id", eventId).single();
    expect(data).toEqual({ state: "failed", last_error: "Fixture did not process" });
  } finally {
    await warehouseContext.close();
  }
});

test("a stale stock form cannot act after switching to catalogue or finance", async ({ browser, page, baseURL }) => {
  const db = localAdminClient();
  const sku = "EDG-Z71";
  const original = await db.from("variants").select("id,stock_on_hand").eq("sku", sku).single();
  if (original.error) throw original.error;
  await signInStaff(page, await createLocalAdminUser("warehouse"));
  const warehouseCookies = await page.context().cookies();
  const path = `/admin/stock/${original.data.id}`;
  for (const role of ["catalogue", "finance"] as const) {
    const other = await browser.newContext({ baseURL });
    try {
      await page.context().clearCookies();
      await page.context().addCookies(warehouseCookies);
      await page.goto(path);
      await page.getByLabel("Received quantity").fill("1");
      const otherPage = await other.newPage();
      await signInStaff(otherPage, await createLocalAdminUser(role));
      await otherPage.goto(path);
      await expect(otherPage).toHaveURL(/\/admin$/);
      await page.context().clearCookies();
      await page.context().addCookies(await other.cookies());
      await page.getByRole("button", { name: "Record stock receipt" }).click();
      await expect(page).toHaveURL(/\/admin$/);
    } finally {
      await other.close();
    }
  }
  const after = await db.from("variants").select("id,stock_on_hand").eq("sku", sku).single();
  expect(after.data).toEqual(original.data);
});
