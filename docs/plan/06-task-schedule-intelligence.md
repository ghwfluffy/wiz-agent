# Phase 06: Task And Schedule Intelligence

## Goal

Make tasks self-explanatory and adjustable. The agent should know why a task is
scheduled, decide whether timing should change based on new information, and
maintain durable schedule memory.

## Current Starting Point

- Tasks have `dueAt`, status, prompt, priority, and events.
- Worker claims due pending tasks.
- `agent-schedule` memory is scaffolded.
- Daily newsletter and three-hour autonomous wake tasks are scaffolded.

## Task Model Enhancements

Add fields or structured task metadata for:

- schedule rationale
- source memory path/message/task id
- recurrence policy
- last agent review time
- next review time
- waiting-on state
- blocked reason
- owner clarification needed

Prefer adding JSON metadata only if the existing table would otherwise churn
too much. If adding columns, document migration and ownership rules.

## Tools

Add or migrate to MCP:

- `update_task_schedule`
- `update_task_status`
- `split_task`
- `create_followup_task`
- `mark_waiting_on`
- `request_clarification`
- `record_schedule_rationale`

Each schedule-changing tool must require rationale.

## Autonomous Wake

Every three hours, the wake task should:

- Search active tasks.
- Read `/assistant/schedule.md`.
- Read `/tasks/schedule-rationale.md`.
- Check recent owner messages.
- Check recently ingested trusted knowledge.
- Decide whether anything needs action now.
- Reschedule tasks only with rationale.
- Avoid noisy outbound messages.

Wake outcomes:

- acted: tool call changed task/memory/outbox.
- observed: no action, observation recorded.
- needs owner: clarification queued according to notification policy.
- failed: failure recorded and next wake still scheduled.

## Daily Planning Or Briefing

Add a daily planning task separate from newsletter synthesis if useful:

- Review tasks due today/tomorrow.
- Identify stale or unclear tasks.
- Ask batched questions.
- Suggest schedule changes.
- Optionally send a short daily briefing.

This should be configurable in memory:

- `/assistant/schedule.md`
- `/assistant/notification-policy.md`

## Web UI

Add task insight features:

- show schedule rationale
- show source message/memory/run
- show agent proposed schedule changes
- show next/last autonomous review
- filter tasks by waiting/blocked/due soon
- edit rationale manually
- "ask agent to reassess this task" button

## Tests

Backend:

- schedule update requires rationale.
- schedule update creates task event and audit.
- wake task creates next wake after running.
- wake task can reschedule another task with rationale.
- failed wake still schedules next wake.
- owner clarification task/message is created for ambiguous work.

Frontend:

- task modal displays schedule rationale.
- schedule change history appears in timeline.
- reassess button starts an agent run.

## Completion Criteria

- Tasks expose why they are scheduled when they are.
- Agent can safely modify schedules through host tools.
- Autonomous wake has useful run outcomes.
- User can inspect and override schedule decisions.
- `./scripts/validate.sh` passes.
