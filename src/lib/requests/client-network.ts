import { isIP } from "node:net";

export function clientNetwork(address: string): string | null {
  const version = isIP(address);
  if (version === 4) return address;
  if (version !== 6 || address.includes("%")) return null;
  const canonical = new URL(`http://[${address}]/`).hostname.slice(1, -1);
  const [head = "", tail] = canonical.split("::");
  const leading = head.split(":").filter(Boolean);
  const trailing = tail?.split(":").filter(Boolean) ?? [];
  const groups = [...leading, ...Array(8 - leading.length - trailing.length).fill("0"), ...trailing];
  if (groups.slice(0, 5).every((group) => group === "0") && groups[5] === "ffff") {
    const high = Number.parseInt(groups[6]!, 16);
    const low = Number.parseInt(groups[7]!, 16);
    return [high >> 8, high & 255, low >> 8, low & 255].join(".");
  }
  return groups.slice(0, 4).join(":") + "::/64";
}
