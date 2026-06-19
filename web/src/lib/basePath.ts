export function normalizeBasePath(value: string | undefined): string {
  const trimmed = (value ?? "").trim();
  if (trimmed === "" || trimmed === "/") {
    return "";
  }

  const prefixed = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return prefixed.endsWith("/") ? prefixed.slice(0, -1) : prefixed;
}

export function normalizedBasePath(): string {
  return normalizeBasePath(import.meta.env.VITE_APP_BASE_PATH);
}

function normalizeUrlBase(value: string): string {
  const trimmed = value.trim();
  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed.replace(/\/+$/, "");
  }
  return normalizeBasePath(trimmed);
}

export function normalizedApiBaseUrl(): string {
  const configuredApiBase = import.meta.env.VITE_API_BASE_URL?.trim();
  return normalizeUrlBase(configuredApiBase && configuredApiBase !== ""
    ? configuredApiBase
    : `${normalizedBasePath()}/api/v1`);
}

export function normalizeAppNextPath(value: string | undefined): string {
  const candidate = (value ?? "").trim();
  if (!candidate.startsWith("/") || candidate.startsWith("//")) {
    return "/";
  }

  const appBase = normalizedBasePath();
  if (!appBase) {
    return candidate;
  }

  if (candidate === appBase) {
    return "/";
  }

  if (candidate.startsWith(`${appBase}/`)) {
    return candidate.slice(appBase.length) || "/";
  }

  if (candidate.startsWith(`${appBase}?`) || candidate.startsWith(`${appBase}#`)) {
    return `/${candidate.slice(appBase.length)}`;
  }

  return candidate;
}

export function currentAppPath(): string {
  if (typeof window === "undefined") {
    return "/";
  }
  return normalizeAppNextPath(`${window.location.pathname}${window.location.search}${window.location.hash}`);
}

function appendDefaultLoginNext(url: string, nextPath = currentAppPath()): string {
  const hashIndex = url.indexOf("#");
  const beforeHash = hashIndex === -1 ? url : url.slice(0, hashIndex);
  const hash = hashIndex === -1 ? "" : url.slice(hashIndex);
  const queryIndex = beforeHash.indexOf("?");
  const pathname = queryIndex === -1 ? beforeHash : beforeHash.slice(0, queryIndex);
  const query = queryIndex === -1 ? "" : beforeHash.slice(queryIndex + 1);

  if (!pathname.endsWith("/auth/login")) {
    return url;
  }

  const params = new URLSearchParams(query);
  if (params.has("next")) {
    return url;
  }

  params.set("next", normalizeAppNextPath(nextPath));
  return `${pathname}?${params.toString()}${hash}`;
}

export function authLoginUrl(nextPath = currentAppPath()): string {
  return appendDefaultLoginNext(`${normalizedApiBaseUrl()}/auth/login`, nextPath);
}

export function apiUrl(path: string): string {
  const suffix = path.startsWith("/") ? path : `/${path}`;
  return appendDefaultLoginNext(`${normalizedApiBaseUrl()}${suffix}`);
}
