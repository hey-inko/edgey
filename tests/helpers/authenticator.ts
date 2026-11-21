import { createHmac } from "node:crypto";

export function authenticatorCode(secret: string) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const key = Buffer.from(secret.replace(/=+$/, "").match(/.{1,8}/g)!.flatMap((part) => {
    const bits = [...part].map((character) => alphabet.indexOf(character).toString(2).padStart(5, "0")).join("");
    return (bits.match(/.{8}/g) ?? []).map((byte) => parseInt(byte, 2));
  }));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
  const mac = createHmac("sha1", key).update(counter).digest();
  const offset = mac.at(-1)! & 0xf;
  return String((mac.readUInt32BE(offset) & 0x7fff_ffff) % 1_000_000).padStart(6, "0");
}
