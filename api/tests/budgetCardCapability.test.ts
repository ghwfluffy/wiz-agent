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
    expect(listIntegrationActions("budget").some(action => action.id === "budget.list_accounts")).toBe(true);
    expect(listIntegrationActions("budget").some(action => action.pathTemplate === "/credit-card-events")).toBe(false);
  });
});
