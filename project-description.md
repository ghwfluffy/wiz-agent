# Project Description

AI Assistant is a personal agent host. It runs scheduled tasks, listens to a
mailbox, queues outbound messages, and uses a controlled tool gateway so the
agent can propose useful work without directly owning credentials, state, or
side effects.

The first implementation runs locally as a standalone single-user app. It uses a
development-only sign-in endpoint to create the local user session. This lets the
product and agent workflows mature before publishing into the omnisite.

The later omnisite deployment will use federated OAuth through the central auth
app. The app itself should never grow a separate password, registration, or local
user-management system.

Core principle:

> Deterministic host code owns state, scheduling, credentials, policy,
> authorization, and side effects. The agent owns language understanding,
> summarization, task interpretation, and proposed actions.
