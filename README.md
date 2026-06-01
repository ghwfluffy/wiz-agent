# AI Assistant

Personal AI assistant service with a scheduler, mailbox listener, controlled
tool gateway, and web administration surface.

## Overview

This project is the agent sub-app for a larger omnisite, and it also runs as a
standalone local application. Local development uses one local tenant and one
local user. The local sign-in button calls a development-only auto-login
endpoint; there is no local password, registration, or user-management system.

In omnisite mode, the app uses federated OAuth through the central auth app
while keeping its own local session and tenant-scoped authorization model.

## Features

- Scheduled personal agent tasks.
- IMAP mailbox ingestion policy and SMTP/SMS/MMS outbound queue.
- Deterministic host policy around credentials, scheduling, and side effects.
- OpenAI-backed agent runtime through configurable model tiers.
- Multi-tenant data model with a single-user standalone development mode.
- Carbon-based web UI for sign-in, tasks, outbox, activity, audit logs, and
  admin operations.

## Tech Stack

- Backend: Node.js, TypeScript, Hono, PostgreSQL, Zod.
- Frontend: Vue 3, Vite, TypeScript, Pinia, Vue Router, Carbon.
- Infrastructure: Docker Compose, Nginx, PostgreSQL.
- Testing: Vitest, Vue Test Utils.

## Getting Started

Development instructions live in [docs/development.md](./docs/development.md).

## Documentation

- Project description: [project-description.md](./project-description.md)
- Development: [docs/development.md](./docs/development.md)
- Project architecture: [docs/architecture/](./docs/architecture/)
- Reusable project standards: [docs/project-standards/README.md](./docs/project-standards/README.md)

## Status

Active development. The app supports standalone local mode and production
omnisite OAuth mode, with live OpenAI and SMTP connector paths behind ignored
secret configuration.
