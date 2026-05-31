# AI Assistant

Personal AI assistant service with a scheduler, mailbox listener, controlled
tool gateway, and web administration surface.

## Overview

This project is the agent sub-app for a larger omnisite, but it starts as a
standalone local application. During early development it runs with one local
tenant and one local user. The local sign-in button calls a development-only
auto-login endpoint; there is no local password, registration, or user
management system.

When the app is ready to publish into the omnisite, it will switch to federated
OAuth through the central auth app while keeping the same local session and
tenant-scoped authorization model.

## Features

- Scheduled personal agent tasks.
- IMAP mailbox listener and SMTP/SMS/MMS outbound queue.
- Deterministic host policy around credentials, scheduling, and side effects.
- OpenAI-backed agent runtime through configurable model tiers.
- Multi-tenant data model with a single-user standalone development mode.
- Carbon-based web UI for tasks, activity, approvals, audit logs, and admin
  configuration.

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

Experimental, active development.
