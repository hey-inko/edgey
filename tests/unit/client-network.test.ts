import { expect, it } from "vitest";
import { clientNetwork } from "@/lib/requests/client-network";

it("canonicalises IPv4-mapped addresses and groups IPv6 addresses by their network", () => {
  expect(clientNetwork("192.0.2.9")).toBe("192.0.2.9");
  expect(clientNetwork("::ffff:192.0.2.9")).toBe("192.0.2.9");
  expect(clientNetwork("2001:0DB8:0102:0304:7:8:9:a")).toBe("2001:db8:102:304::/64");
  expect(clientNetwork("2001:db8:102:304::f")).toBe("2001:db8:102:304::/64");
  expect(clientNetwork("2001:db8:102:305::f")).toBe("2001:db8:102:305::/64");
  expect(clientNetwork("2001:db8::1")).toBe("2001:db8:0:0::/64");
  expect(clientNetwork("fe80::1%eth0")).toBeNull();
  expect(clientNetwork("192.0.2.9, 192.0.2.10")).toBeNull();
});
