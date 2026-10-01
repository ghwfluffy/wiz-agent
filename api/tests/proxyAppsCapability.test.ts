import { describe, expect, it } from "vitest";
import { buildCapabilityContext, getAppCapability, listIntegrationActions } from "../src/integrations/capabilityRegistry.js";

describe("Proxy Apps capability boundary", () => {
  it("explains desktop terminals without granting an assistant execution tool", () => {
    const app = getAppCapability("proxy_apps");
    expect(app.baseUrlSetting).toBe("none");
    expect(app.dataSensitivity).toBe("highly_private");
    expect(listIntegrationActions("proxy_apps")).toEqual([]);
    expect(buildCapabilityContext()).toContain("No delegated assistant token");
    expect(app.modelGuidance.join(" ")).toContain("Never obtain P12");
  });
});
