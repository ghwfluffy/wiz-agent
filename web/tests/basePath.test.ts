import { describe, expect, it } from "vitest";
import { normalizeBasePath } from "../src/lib/basePath";

describe("base path helpers", () => {
  it("normalizes empty and root paths", () => {
    expect(normalizeBasePath("")).toBe("");
    expect(normalizeBasePath("/")).toBe("");
    expect(normalizeBasePath(undefined)).toBe("");
  });

  it("normalizes non-root paths", () => {
    expect(normalizeBasePath("agent")).toBe("/agent");
    expect(normalizeBasePath("/agent/")).toBe("/agent");
  });
});
