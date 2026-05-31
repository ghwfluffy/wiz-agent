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

export function apiUrl(path: string): string {
  const apiBase = normalizeBasePath(import.meta.env.VITE_API_BASE_URL || "/api/v1");
  const suffix = path.startsWith("/") ? path : `/${path}`;
  return `${apiBase}${suffix}`;
}
