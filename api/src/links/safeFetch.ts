import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export type SafeUrlResult =
  | { ok: true; url: URL }
  | { ok: false; reason: string };

function isPrivateIp(address: string): boolean {
  if (address === "127.0.0.1" || address === "::1") {
    return true;
  }
  if (address.startsWith("10.") || address.startsWith("192.168.")) {
    return true;
  }
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(address)) {
    return true;
  }
  if (address.startsWith("169.254.") || address.toLowerCase().startsWith("fe80:")) {
    return true;
  }
  if (address === "0.0.0.0" || address === "::") {
    return true;
  }
  return false;
}

export async function validateSafeHttpUrl(rawUrl: string): Promise<SafeUrlResult> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, reason: "invalid_url" };
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    return { ok: false, reason: "unsupported_protocol" };
  }
  if (url.hostname.toLowerCase() === "localhost") {
    return { ok: false, reason: "private_host" };
  }
  if (isIP(url.hostname) !== 0) {
    return isPrivateIp(url.hostname) ? { ok: false, reason: "private_ip" } : { ok: true, url };
  }
  const addresses = await lookup(url.hostname, { all: true }).catch(() => []);
  if (addresses.some((entry) => isPrivateIp(entry.address))) {
    return { ok: false, reason: "private_dns" };
  }
  return { ok: true, url };
}
