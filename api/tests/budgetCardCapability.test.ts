import { describe, expect, it } from "vitest";
import { getAppCapability, listIntegrationActions } from "../src/integrations/capabilityRegistry.js";

describe("Budget card bookkeeping capability", () => {
  it("explains planner payments while retaining scoped configuration boundaries", () => {
    const app = getAppCapability("budget");
    const guidance = app.modelGuidance.join(" ");
    expect(guidance).toContain("minimum_payment_cents");
    expect(guidance).toContain("not bank instructions");
    expect(guidance).toContain("not automatic-payment configuration");
    expect(guidance).toContain("without reducing net worth");
    const accountRead = listIntegrationActions("budget").find(action => action.id === "budget.get_account");
    expect(accountRead?.responseUse).toContain("stored_balance_cents");
    expect(accountRead?.responseUse).toContain("Never write a queued-payment preview");
    const forecast = listIntegrationActions("budget").find(action => action.id === "budget.get_net_worth_forecast");
    expect(forecast?.responseUse).toContain("$10,000");
    expect(forecast?.responseUse).toContain("$5,000");
    expect(forecast?.responseUse).toContain("highest APR first");
    expect(forecast?.responseUse).toContain("projection-only");
    expect(forecast?.responseUse).toContain("never create real transfers");
    expect(listIntegrationActions("budget").some(action => action.id === "budget.list_accounts")).toBe(true);
    expect(listIntegrationActions("budget").some(action => action.pathTemplate === "/credit-card-events")).toBe(false);
  });
});
