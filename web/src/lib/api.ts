import { apiUrl } from "./basePath";

export type AuthUser = {
  id: string;
  email: string;
  displayName: string;
  isAdmin: boolean;
};

export type Tenant = {
  id: string;
  name: string;
};

export type AuthMeResponse = {
  authenticated: boolean;
  user: AuthUser | null;
  tenant: Tenant | null;
  expiresAt?: string;
};

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(apiUrl(path), {
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...init.headers
    },
    ...init
  });

  if (!response.ok) {
    throw new Error(`Request failed with status ${response.status}`);
  }

  return (await response.json()) as T;
}

export const api = {
  me(): Promise<AuthMeResponse> {
    return request<AuthMeResponse>("/auth/me");
  },
  devLogin(): Promise<AuthMeResponse> {
    return request<AuthMeResponse>("/auth/dev-login", { method: "POST" });
  },
  logout(): Promise<AuthMeResponse> {
    return request<AuthMeResponse>("/auth/logout", { method: "POST" });
  }
};
