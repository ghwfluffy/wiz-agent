# App Capability Registry

The agent keeps durable knowledge about other apps in code at
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

Every owner-command entry point must carry that provider into the tool runtime.
This includes authenticated web and voice prompts as well as owner-classified
IMAP/SMS/MMS messages processed by the worker. The worker constructs the signed
provider from its loaded settings; it must never omit integration authorization
merely because the owner command arrived through messaging.

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
- listing transfers, contracts, expenses, investments, and audit logs;
- creating, updating, and deleting recurring contracts and projected expenses.

Use Fluffynomics when the owner asks about accounts, balances, net worth,
forecasts, bills, expenses, investments, transfers, or financial history.

### Federated Services

Federated Services is directory knowledge for the central authenticated
launcher, account settings, app switching, registration-code management, user
administration, and OAuth service administration.

It has no agent-callable integration actions, no app API token, and no internal
base URL setting in this registry. Use it only to tell the owner where shared
account or app-launcher settings live. Do not claim the agent can edit shared
identity or directory records unless a dedicated scoped API is added later.

### Apartment Gate

Apartment Gate is a federated-login protected mobile web app for opening
apartment community gates and doors. Its credentials and rendered page source
are highly private. It exposes one scoped agent API for the configured right
gate.

The registry includes Apartment Gate with a single high-risk write action:

- `apartment_gate.open_right_gate` calls the app's internal agent endpoint with
  a short-lived token scoped to that exact action;
- direct execution is allowed for current authenticated owner commands from web
  chat, mobile voice, or owner-classified inbound messaging;
- autonomous, scheduled, stale, or non-owner contexts must not execute physical
  access actions and must be rejected rather than queued for approval;
- the agent must not open any other physical access points;
- the agent must not request, store, summarize, or expose provider credentials,
  refresh tokens, API keys, or generated page source.

### Android Assistant

Android Assistant is a native mobile wrapper and home-screen widget entrypoint.
It does not expose cross-app actions to the agent. Voice widget recordings are
transcribed by the agent backend and then handled like authenticated web chat,
using the same owner-command tools, approval policies, and integration
boundaries.

### Omni Dev

Omni Dev is the private development-job control plane. Wrapper tools can create
a scoped objective with the selected durable conversation thread, read job
status, or request cancellation. An owner-command job executes through the
scoped integration path; an assistant suggestion first becomes a cross-app
approval. The downstream service independently classifies sensitive objectives,
signs the runner intent, and requires another owner confirmation for protected
changes. The agent never receives Git, SSH, Codex, or deploy credentials.
Owner image attachments are never added to ordinary model context. Host code may
decode, resize, metadata-strip, re-encode, and integrity-bind supported images
to the signed development context; untrusted and non-image attachments remain
metadata-only.

## Maintenance Rule

Whenever a future agent request adds or changes an app, app API, or major
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
