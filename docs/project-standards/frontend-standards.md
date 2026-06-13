# Frontend Standards

## Framework

Use Vue single-file components with TypeScript, Vite, Pinia, Vue Router, and
Carbon CSS. This project uses `@carbon/styles` v11 component class markup rather
than PrimeVue or the older `@carbon/vue` package.

## Layout

Recommended layout:

- `web/src/main.ts`: application bootstrap, Carbon CSS import, router, Pinia, and global CSS.
- `web/src/App.vue`: top-level shell.
- `web/src/router`: route definitions and auth-aware navigation.
- `web/src/stores`: Pinia stores for auth, profile, domain resources, admin resources, notifications, and status.
- `web/src/lib`: API client, base-path helpers, date/time helpers, theme bridge, toast helpers, and presentation-only domain helpers.
- `web/src/components`: reusable components split by domain or shell area.
- `web/src/views`: route-level composition components.

## Rules

Frontend code should:

- keep route views thin and composition-oriented
- extract reusable management shells, toolbars, tables, dialogs, and card/list patterns
- use Pinia stores for shared server state and cross-view actions
- centralize API fetch logic in `web/src/lib/api.ts` or focused API modules
- use a shared toast service for user feedback, including user-visible API failures
- parse API error envelopes in the shared API client and show the human-readable error message in a toast when a request fails
- restore auth state from `/auth/me` on app load
- use browser timezone for timestamp display unless the project defines another display timezone
- include mobile and desktop layouts from the start for core workflows

Frontend code must not:

- implement authorization as a frontend-only concern
- duplicate API fetch logic across components
- hide API failures in console logs or component-local state without a user-visible toast
- let route views become large mixed-responsibility files
- rebuild controls that Carbon CSS already provides through documented component
  markup, especially tabs, data tables, modals, form controls, notifications,
  tags, and pagination

## Agent Chat

The Chat tab should behave like a normal conversation surface: one message
composer, Enter-to-send with Shift+Enter for newlines, one chronological message
thread, and a clear-chat action. Follow-up messages must include bounded recent
browser chat context in the submitted prompt so pronouns and references to prior
answers remain understandable. Chat prompt submissions should use `normal` mode
so the agent can reason, call the right bounded tools, and synthesize a complete
answer. The production API proxy timeout should be long enough for the configured
runtime budget. Keep run ids, selected tool names, raw tool JSON, prompt modes,
task selectors, memory selectors, and other debugging or operator controls out
of this screen. Put advanced prompt controls in admin/overview/operator surfaces
instead.

## API Error Feedback

The web app should surface failed API requests through the shared toast service by default. The shared API client should parse the backend error envelope, prefer the envelope's human-readable message, and fall back to a generic message when the response is malformed or unavailable.

Suppressing an API error toast should be an explicit per-call choice for flows that already show the error inline, such as field-level validation, silent auth restoration, or background polling.

## Polling And Forms

Background polling must not overwrite an actively edited form. Long-lived admin
or settings forms should track dirty state and apply refreshed server values to
the display model without copying them into form inputs until the user saves,
clears, or reloads the form.

## Timezone Boundary

The frontend may display timestamps in the browser timezone. Server-side day-boundary, schedule, and compliance semantics should use the saved user profile timezone.
