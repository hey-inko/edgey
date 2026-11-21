import { randomUUID } from "node:crypto";
import { expect, test } from "vitest";
import { connectAccountDb, createAccountBuyer } from "../helpers/account-fixture";

test("warehouse alone edits delivery policy and a district overrides its area without fallback", async () => {
  const db = await connectAccountDb();
  await db.query("begin");
  try {
    const [warehouse, finance] = [await createAccountBuyer(db), await createAccountBuyer(db)];
    await db.query("insert into public.staff_members (user_id, role) values ($1, 'warehouse'), ($2, 'finance')",
      [warehouse.id, finance.id]);
    const actor = (id: string, aal = "aal2") => db.query(
      "select set_config('request.jwt.claims', json_build_object('sub', $1::text, 'aal', $2::text)::text, true)",
      [id, aal],
    );
    await db.query("set local role authenticated");
    await actor(finance.id);
    expect((await db.query("select * from public.delivery_rules")).rows).toEqual([]);
    expect((await db.query("select * from public.delivery_calendars")).rows).toEqual([]);
    const insertRule = "insert into public.delivery_rules (scope, code, kind) values ('district', 'SW1A', 'enquiry')";
    await db.query("savepoint unauthorized");
    await expect(db.query(insertRule)).rejects.toMatchObject({ code: "42501" });
    await db.query("rollback to savepoint unauthorized");

    await actor(warehouse.id);
    await expect(db.query(insertRule)).resolves.toMatchObject({ rowCount: 1 });
    await expect(db.query("update public.delivery_calendars set closures = array[date '2026-11-24'] where calendar = 'warehouse'"))
      .resolves.toMatchObject({ rowCount: 1 });
    await db.query("savepoint invalid");
    await expect(db.query("update public.delivery_rules set kind = 'agreed', working_days = 3 where code = 'SW1A'"))
      .rejects.toMatchObject({ code: "23514" });
    await db.query("rollback to savepoint invalid");
    for (const fn of ["checkout_delivery_terms('SW1A 1AA')", "checkout_warehouse_calendar()"]) {
      await db.query("savepoint checkout_read");
      await expect(db.query(`select public.${fn}`)).rejects.toMatchObject({ code: "42501" });
      await db.query("rollback to savepoint checkout_read");
    }

    await db.query("reset role; set local role service_role");
    const resolve = async (postcode: string) =>
      (await db.query("select public.checkout_delivery_terms($1) as terms", [postcode])).rows[0]?.terms;
    expect(await resolve("SW1A 1AA")).toBeNull();
    const terms = await resolve("SW2 1AA");
    expect(terms).toMatchObject({
      version: 1,
      quote: { kind: "next-working-day", chargeExVatPence: 695, workingDays: 1 },
      warehouseCalendar: { closures: ["2026-11-24"] },
      deliveryCalendar: { closures: [] },
    });
    expect(await resolve("BT1 5GS")).toBeNull();
    const attemptToken = randomUUID();
    const reserve = (snapshot: unknown, paymentMethod: "card" | "net30", buyerId: string | null) =>
      db.query(`select public.reserve_order_with_delivery(
        $1, '[]', '{}', '{"postcode":"SW3 1AA"}', '{"goods_net_pence":2250,"delivery_net_pence":695}',
        now() + interval '35 minutes', 'Next working day', date '2026-11-24', date '2026-11-25',
        $2::jsonb, $3, $4, null
      )`, [attemptToken, snapshot, paymentMethod, buyerId]);
    for (const [snapshot, method, buyerId, message] of [
      [{ ...terms, cutoffMinutes: 929 }, "card", null, "delivery_terms_changed"],
      [null, "card", null, "invalid_delivery_terms"],
      [{ ...terms, version: 2 }, "card", null, "invalid_delivery_terms"],
      [terms, "net30", warehouse.id, "invalid_reservation_payment_method"],
    ] as const) {
      await db.query("savepoint invalid_reservation");
      await expect(reserve(snapshot, method, buyerId)).rejects.toMatchObject({ code: "22023", message });
      await db.query("rollback to savepoint invalid_reservation");
    }
    expect((await db.query("select id from public.orders where checkout_attempt_token=$1", [attemptToken])).rowCount).toBe(0);
    await db.query("reset role; delete from public.delivery_calendars where calendar = 'carrier'; set local role service_role");
    expect(await resolve("SW2 1AA")).toBeNull();
    const schedule = (await db.query("select public.checkout_warehouse_calendar() as schedule")).rows[0]?.schedule;
    expect(schedule).toEqual({ warehouseCalendar: terms.warehouseCalendar, cutoffMinutes: terms.cutoffMinutes });
    await db.query("reset role; set local role anon");
    await expect(db.query("select public.checkout_warehouse_calendar()")).rejects.toMatchObject({ code: "42501" });
  } finally {
    await db.query("rollback");
    await db.end();
  }
});
