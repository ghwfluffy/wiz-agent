import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

export type SafeUrlResult =
  | { ok: true; url: URL }
  | { ok: false; reason: string };

type LookupResult = { address: string; family: number };
type LookupAll = (hostname: string) => Promise<LookupResult[]>;

const blockedAddresses = new BlockList();

for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4]
] as const) {
  blockedAddresses.addSubnet(network, prefix, "ipv4");
}

for (const [network, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["64:ff9b::", 96],
  ["100::", 64],
  ["2001:db8::", 32],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8]
] as const) {
  blockedAddresses.addSubnet(network, prefix, "ipv6");
}

const blockedHostnames = new Set([
  "localhost",
  "localhost.localdomain",
  "metadata.google.internal",
  "metadata.google.internal."
]);

const blockedHostnameSuffixes = [
  ".localhost",
  ".local",
  ".internal",
  ".home.arpa",
  ".invalid",
  ".test"
];

function normalizeHostname(hostname: string): string {
  return hostname.replace(/^\[|\]$/g, "").toLowerCase().replace(/\.$/, "");
}

export function isPublicIpAddress(address: string): boolean {
  const normalized = normalizeHostname(address);
  if (normalized.startsWith("::ffff:")) {
    return false;
  }
  const family = isIP(normalized);
  if (family === 4) {
    return !blockedAddresses.check(normalized, "ipv4");
  }
  if (family === 6) {
    return !blockedAddresses.check(normalized, "ipv6");
  }
  return false;
}

function isBlockedHostname(hostname: string): boolean {
  const normalized = normalizeHostname(hostname);
  return blockedHostnames.has(normalized) || blockedHostnameSuffixes.some((suffix) => normalized.endsWith(suffix));
}

async function defaultLookupAll(hostname: string): Promise<LookupResult[]> {
  return lookup(hostname, { all: true, verbatim: true });
}

export async function validateSafeHttpUrl(
  rawUrl: string,
  options: { lookupAll?: LookupAll } = {}
): Promise<SafeUrlResult> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, reason: "invalid_url" };
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    return { ok: false, reason: "unsupported_protocol" };
  }
  if (url.username || url.password) {
    return { ok: false, reason: "embedded_credentials" };
  }
  if (url.port && !["80", "443"].includes(url.port)) {
    return { ok: false, reason: "unsafe_port" };
  }

  const hostname = normalizeHostname(url.hostname);
  if (!hostname || isBlockedHostname(hostname)) {
    return { ok: false, reason: "private_host" };
  }
  if (isIP(hostname) !== 0) {
    return isPublicIpAddress(hostname) ? { ok: true, url } : { ok: false, reason: "private_ip" };
  }

  const addresses = await (options.lookupAll ?? defaultLookupAll)(hostname).catch(() => []);
  if (addresses.length === 0) {
    return { ok: false, reason: "dns_lookup_failed" };
  }
  if (addresses.some((entry) => !isPublicIpAddress(entry.address))) {
    return { ok: false, reason: "private_dns" };
  }
  return { ok: true, url };
}
