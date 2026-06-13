# App Capability Registry

The agent keeps durable knowledge about other GHWIZ apps in code at
`api/src/integrations/capabilityRegistry.ts`.

This registry is the source of truth for what the agent understands about
omnisite apps. It is intentionally separate from production routing. The root
repo owns production hostnames, subpaths, compose aliases, and secret layout.

## Purpose

The registry gives the model useful context without granting it direct
authority. Each app entry describes:

- what the app is for;
- when the agent should consider using it;
- how sensitive the data is;
- which app API actions are allowed;
- whether each action is read-only or mutating;
- the endpoint shape used by deterministic backend code;
- safety rules and response guidance.

The model can query the registry through the read-only
`list_app_capabilities` MCP tool. For common workflows, model-facing wrapper
tools expose simpler schemas and map internally to registered action ids.
`integration_action` remains an advanced fallback for registered action ids.
Deterministic host code still owns endpoint allowlisting, token lookup, user
context headers, authorization, audit logging, redaction, and side-effect
execution.

The production token provider mints short-lived HMAC-signed bearer tokens from
`AGENT_INTEGRATION_TOKEN_SECRET`. Tokens are scoped to the current central OAuth
subject, target app, and exact action id. Missing signing configuration or a
non-OAuth local user fails closed without calling the target app.

## Current Apps

### Goals

Goals is for personal goal tracking, manual progress updates, metrics,
checklist goals, reminders, dashboards, and shareable widgets.

The registry includes actions for:

- listing goals;
- creating or updating goals;
- completing checklist items;
- listing and creating metrics;
- recording metric entries;
- listing and completing notifications.

Use Goals when the owner asks about objectives, habits, measurements,
progress, reminders, or what to work on next.

### Fluffynomics

Fluffynomics is for personal finance planning with accounts, net worth
history/forecast, contracts, expenses, investments, transfers, and audit logs.
Its data is highly private.

The registry includes actions for:

- listing accounts;
- reading a specific account;
- reading net-worth history and forecast data;
- recording owner-provided account value updates;
- listing transfers, contracts, expenses, investments, and audit logs.

Use Fluffynomics when the owner asks about accounts, balances, net worth,
forecasts, bills, expenses, investments, transfers, or financial history.

### Apartment Gate

Apartment Gate is a federated-login protected mobile web app for opening
apartment community gates and doors. Its credentials and rendered page source
are highly private, and there is no agent-callable API.

The registry includes Apartment Gate as directory knowledge only:

- no integration actions are available;
- `list_app_capabilities` may describe the app, but no MCP tool is exposed for
  opening gates or doors;
- the agent may explain where the app is and how access is protected;
- the agent must not try to open physical access points;
- the agent must not request, store, summarize, or expose Gatewise credentials,
  refresh tokens, API keys, or generated page source.

## Maintenance Rule

Whenever a future agent request adds or changes a GHWIZ app, app API, or major
capability, update the registry in the same change. Do not leave the agent with
stale app knowledge.

Registry updates should include:

- app purpose and sensitivity;
- allowed action ids;
- endpoint method and path template;
- path/query parameters;
- body summary for mutating actions;
- when the model should use the action;
- safety boundaries;
- response guidance;
- tests for the registry and gateway behavior.

If an app or feature should not be available to the agent, document that
explicitly in the root architecture docs and in this submodule's architecture
docs.
