import type { Settings } from "../config/settings.js";
import type { AgentStore, InboundMessageRecord, RequestContext } from "../domain/types.js";
import type { IntegrationActionId } from "../integrations/capabilityRegistry.js";
import {
  callIntegrationActionApi,
  type IntegrationTokenProvider
} from "./integrationGateway.js";
import type { ToolName } from "./contracts.js";

export type ToolExecutionResult = {
  executed: boolean;
  sideEffect: "none" | "local_persistence" | "cross_app_api";
  result: Record<string, unknown>;
};

export async function executeToolCall(options: {
  context: RequestContext;
  store: AgentStore;
  toolName: ToolName;
  args: Record<string, unknown>;
  settings?: Settings;
  integrationTokenProvider?: IntegrationTokenProvider;
  fetchImpl?: typeof fetch;
  replyToMessage?: Pick<InboundMessageRecord, "fromAddr" | "source" | "subject">;
}): Promise<ToolExecutionResult> {
  switch (options.toolName) {
    case "create_task": {
      const task = await options.store.createTask(options.context, {
        title: String(options.args.title),
        prompt: String(options.args.prompt),
        dueAt: typeof options.args.dueAt === "string" ? options.args.dueAt : null,
        priority: typeof options.args.priority === "number" ? options.args.priority : 0
      });
      const events = await options.store.listTaskEvents(options.context, task.id);
      return {
        executed: true,
        sideEffect: "local_persistence",
        result: {
          task_id: task.id,
          task_event_id: events.find((event) => event.eventType === "task.created")?.id ?? null,
          status: task.status,
          due_at: task.dueAt
        }
      };
    }
    case "list_ongoing_tasks": {
      const tasks = (await options.store.listTasks(options.context))
        .filter((task) => !["completed", "cancelled", "failed"].includes(task.status))
        .slice(0, 20)
        .map((task) => ({
          task_id: task.id,
          title: task.title,
          status: task.status,
          due_at: task.dueAt,
          priority: task.priority,
          prompt_excerpt: task.prompt.slice(0, 240)
        }));
      return {
        executed: true,
        sideEffect: "none",
        result: { tasks }
      };
    }
    case "list_recent_context": {
      const limit = typeof options.args.limit === "number" ? options.args.limit : 8;
      const tasks = (await options.store.listTasks(options.context))
        .slice(0, limit)
        .map((task) => ({
          task_id: task.id,
          title: task.title,
          status: task.status,
          due_at: task.dueAt,
          priority: task.priority,
          prompt_excerpt: excerpt(task.prompt, 240),
          updated_at: task.updatedAt
        }));
      const inbound = (await options.store.listInboundMessages(options.context))
        .filter((message) => message.classification === "owner")
        .slice(0, limit)
        .map((message) => ({
          message_id: message.id,
          source: message.source ?? "imap",
          received_at: message.receivedAt ?? message.createdAt,
          subject: message.subject,
          body_excerpt: excerpt(message.bodyText, 240),
          handling_action: message.handlingAction,
          task_id: message.taskId
        }));
      const outbound = (await options.store.listOutboundMessages(options.context))
        .slice(0, limit)
        .map((message) => ({
          outbound_message_id: message.id,
          channel: message.channel,
          status: message.status,
          subject: message.subject,
          body_excerpt: excerpt(message.bodyText, 240),
          created_at: message.createdAt,
          sent_at: message.sentAt ?? null
        }));
      return {
        executed: true,
        sideEffect: "none",
        result: { tasks, inbound, outbound }
      };
    }
    case "list_recent_owner_conversations": {
      const limit = typeof options.args.limit === "number" ? options.args.limit : 8;
      const inbound = (await options.store.listInboundMessages(options.context))
        .filter((message) => message.classification === "owner")
        .slice(0, limit)
        .map((message) => ({
          message_id: message.id,
          direction: "inbound",
          source: message.source ?? "imap",
          timestamp: message.receivedAt ?? message.createdAt,
          subject: message.subject,
          body_excerpt: excerpt(message.bodyText, 500),
          handling_action: message.handlingAction,
          task_id: message.taskId
        }));
      const outbound = (await options.store.listOutboundMessages(options.context))
        .slice(0, limit)
        .map((message) => ({
          outbound_message_id: message.id,
          direction: "outbound",
          channel: message.channel,
          status: message.status,
          timestamp: message.sentAt ?? message.createdAt,
          subject: message.subject,
          body_excerpt: excerpt(message.bodyText, 500)
        }));
      return {
        executed: true,
        sideEffect: "none",
        result: {
          conversations: [...inbound, ...outbound]
            .sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)))
            .slice(0, limit)
        }
      };
    }
    case "write_memory": {
      const slug = String(options.args.slug);
      const title = String(options.args.title);
      const appendMarkdown = String(options.args.appendMarkdown).trim();
      const existing = await options.store.getMemoryDocument(options.context, slug);
      const document = await options.store.upsertMemoryDocument(options.context, {
        slug,
        title: existing?.title ?? title,
        body: [
          existing?.body?.trim() || `# ${title}`,
          "",
          appendMarkdown
        ].join("\n")
      });
      return {
        executed: true,
        sideEffect: "local_persistence",
        result: {
          memory_document_id: document.id,
          slug: document.slug,
          rationale: options.args.rationale
        }
      };
    }
    case "append_task_prompt": {
      const taskId = String(options.args.taskId);
      const task = await options.store.getTask(options.context, taskId);
      if (!task) {
        return {
          executed: false,
          sideEffect: "none",
          result: { reason: "task_not_found" }
        };
      }
      const prompt = String(options.args.prompt);
      const updated = await options.store.updateTask(options.context, taskId, {
        prompt: `${task.prompt}\n\nInbound follow-up:\n${prompt}`,
        status: String(options.args.status)
      });
      const event = await options.store.recordTaskEvent(options.context, taskId, "task.prompt_added", {
        prompt,
        summary: "Inbound owner message appended to task and returned to active work."
      });
      return {
        executed: Boolean(updated),
        sideEffect: "local_persistence",
        result: {
          task_id: taskId,
          task_event_id: event.id,
          status: updated?.status ?? null
        }
      };
    }
    case "update_task_schedule": {
      const taskId = String(options.args.taskId);
      const task = await options.store.getTask(options.context, taskId);
      if (!task) {
        return {
          executed: false,
          sideEffect: "none",
          result: { reason: "task_not_found" }
        };
      }
      const updated = await options.store.updateTask(options.context, taskId, {
        dueAt: typeof options.args.dueAt === "string" ? options.args.dueAt : null,
        scheduleRationale: String(options.args.rationale),
        nextReviewAt: typeof options.args.nextReviewAt === "string" ? options.args.nextReviewAt : null
      });
      const event = await options.store.recordTaskEvent(options.context, taskId, "task.schedule_updated", {
        due_at: updated?.dueAt ?? null,
        rationale: String(options.args.rationale),
        confidence: String(options.args.confidence),
        next_review_at: updated?.nextReviewAt ?? null,
        summary: "Agent updated the task schedule with rationale."
      });
      return {
        executed: Boolean(updated),
        sideEffect: "local_persistence",
        result: {
          task_id: taskId,
          task_event_id: event.id,
          due_at: updated?.dueAt ?? null,
          rationale: options.args.rationale,
          confidence: options.args.confidence
        }
      };
    }
    case "update_task_status": {
      const taskId = String(options.args.taskId);
      const task = await options.store.getTask(options.context, taskId);
      if (!task) {
        return {
          executed: false,
          sideEffect: "none",
          result: { reason: "task_not_found" }
        };
      }
      const updated = await options.store.updateTask(options.context, taskId, {
        status: String(options.args.status),
        waitingOn: Object.hasOwn(options.args, "waitingOn")
          ? (typeof options.args.waitingOn === "string" ? options.args.waitingOn : null)
          : task.waitingOn,
        blockedReason: Object.hasOwn(options.args, "blockedReason")
          ? (typeof options.args.blockedReason === "string" ? options.args.blockedReason : null)
          : task.blockedReason,
        ownerClarificationNeeded: Object.hasOwn(options.args, "ownerClarificationNeeded")
          ? options.args.ownerClarificationNeeded === true
          : task.ownerClarificationNeeded,
        scheduleRationale: String(options.args.rationale)
      });
      const event = await options.store.recordTaskEvent(options.context, taskId, "task.status_updated", {
        status: updated?.status ?? null,
        rationale: String(options.args.rationale),
        waiting_on: updated?.waitingOn ?? null,
        blocked_reason: updated?.blockedReason ?? null,
        owner_clarification_needed: updated?.ownerClarificationNeeded ?? false,
        summary: "Agent updated the task status with rationale."
      });
      return {
        executed: Boolean(updated),
        sideEffect: "local_persistence",
        result: {
          task_id: taskId,
          task_event_id: event.id,
          status: updated?.status ?? null,
          rationale: options.args.rationale
        }
      };
    }
    case "split_task": {
      const taskId = String(options.args.taskId);
      const task = await options.store.getTask(options.context, taskId);
      if (!task) {
        return {
          executed: false,
          sideEffect: "none",
          result: { reason: "task_not_found" }
        };
      }
      const created = [];
      for (const item of Array.isArray(options.args.newTasks) ? options.args.newTasks : []) {
        const child = item as Record<string, unknown>;
        const newTask = await options.store.createTask(options.context, {
          title: String(child.title),
          prompt: String(child.prompt),
          dueAt: typeof child.dueAt === "string" ? child.dueAt : null,
          priority: typeof child.priority === "number" ? child.priority : task.priority,
          scheduleRationale: String(child.scheduleRationale),
          sourceTaskId: task.id
        });
        created.push(newTask);
      }
      const event = await options.store.recordTaskEvent(options.context, taskId, "task.split", {
        rationale: String(options.args.rationale),
        child_task_ids: created.map((entry) => entry.id),
        summary: "Agent split this task into follow-up tasks."
      });
      return {
        executed: created.length > 0,
        sideEffect: "local_persistence",
        result: {
          task_id: taskId,
          task_event_id: event.id,
          child_task_ids: created.map((entry) => entry.id),
          rationale: options.args.rationale
        }
      };
    }
    case "create_followup_task": {
      const sourceTaskId = typeof options.args.sourceTaskId === "string" ? options.args.sourceTaskId : undefined;
      const sourceTask = sourceTaskId ? await options.store.getTask(options.context, sourceTaskId) : undefined;
      if (sourceTaskId && !sourceTask) {
        return {
          executed: false,
          sideEffect: "none",
          result: { reason: "source_task_not_found" }
        };
      }
      const task = await options.store.createTask(options.context, {
        title: String(options.args.title),
        prompt: String(options.args.prompt),
        dueAt: typeof options.args.dueAt === "string" ? options.args.dueAt : null,
        priority: typeof options.args.priority === "number" ? options.args.priority : sourceTask?.priority ?? 0,
        scheduleRationale: String(options.args.rationale),
        sourceTaskId: sourceTask?.id ?? null
      });
      const event = sourceTask
        ? await options.store.recordTaskEvent(options.context, sourceTask.id, "task.followup_created", {
          followup_task_id: task.id,
          rationale: String(options.args.rationale),
          summary: "Agent created a follow-up task."
        })
        : undefined;
      return {
        executed: true,
        sideEffect: "local_persistence",
        result: {
          task_id: task.id,
          source_task_id: sourceTask?.id ?? null,
          source_task_event_id: event?.id ?? null,
          due_at: task.dueAt,
          rationale: options.args.rationale
        }
      };
    }
    case "mark_waiting_on": {
      const taskId = String(options.args.taskId);
      const task = await options.store.getTask(options.context, taskId);
      if (!task) {
        return {
          executed: false,
          sideEffect: "none",
          result: { reason: "task_not_found" }
        };
      }
      const updated = await options.store.updateTask(options.context, taskId, {
        status: "waiting",
        waitingOn: String(options.args.waitingOn),
        scheduleRationale: String(options.args.rationale),
        nextReviewAt: typeof options.args.nextReviewAt === "string" ? options.args.nextReviewAt : null
      });
      const event = await options.store.recordTaskEvent(options.context, taskId, "task.waiting_on", {
        waiting_on: String(options.args.waitingOn),
        rationale: String(options.args.rationale),
        next_review_at: updated?.nextReviewAt ?? null,
        summary: "Agent marked the task as waiting with rationale."
      });
      return {
        executed: Boolean(updated),
        sideEffect: "local_persistence",
        result: {
          task_id: taskId,
          task_event_id: event.id,
          status: updated?.status ?? null,
          waiting_on: updated?.waitingOn ?? null,
          rationale: options.args.rationale
        }
      };
    }
    case "propose_outbound_message": {
      const approvalRequired = options.args.approvalRequired === true;
      const destination = await resolveOwnerReplyDestination(options);
      if (!destination) {
        return {
          executed: false,
          sideEffect: "none",
          result: { reason: "owner_reply_destination_unavailable" }
        };
      }
      const message = await options.store.queueOutboundMessage(options.context, {
        channel: destination.channel,
        status: approvalRequired ? "requires_approval" : "pending",
        toAddr: destination.toAddr,
        subject: typeof options.args.subject === "string" ? options.args.subject : null,
        bodyText: String(options.args.body)
      });
      return {
        executed: true,
        sideEffect: "local_persistence",
        result: {
          outbound_message_id: message.id,
          status: message.status,
          approval_required: approvalRequired,
          destination: destination.source
        }
      };
    }
    case "request_clarification":
    case "ask_owner_clarification": {
      const urgency = String(options.args.urgency);
      if (urgency === "now") {
        const destination = await resolveOwnerReplyDestination(options);
        if (!destination) {
          return {
            executed: false,
            sideEffect: "none",
            result: { reason: "owner_clarification_destination_unavailable" }
          };
        }
        const message = await options.store.queueOutboundMessage(options.context, {
          channel: destination.channel,
          status: "pending",
          toAddr: destination.toAddr,
          bodyText: String(options.args.question)
        });
        return {
          executed: true,
          sideEffect: "local_persistence",
          result: {
            clarification_request_id: message.id,
            outbound_message_id: message.id,
            status: message.status,
            urgency,
            destination: destination.source
          }
        };
      }

      const relatedTaskId = typeof options.args.relatedTaskId === "string" ? options.args.relatedTaskId : undefined;
      const relatedTask = relatedTaskId ? await options.store.getTask(options.context, relatedTaskId) : undefined;
      if (relatedTask) {
        await options.store.updateTask(options.context, relatedTask.id, {
          ownerClarificationNeeded: true,
          scheduleRationale: typeof options.args.rationale === "string" ? options.args.rationale : relatedTask.scheduleRationale
        });
      }
      const task = await options.store.createTask(options.context, {
        title: "Clarify owner request",
        prompt: [
          "Ask the owner for clarification before proceeding.",
          "",
          `Question: ${String(options.args.question)}`,
          relatedTask ? `Related task: ${relatedTask.title} (${relatedTask.id})` : null
        ].filter(Boolean).join("\n"),
        priority: urgency === "daily_briefing" ? 40 : 20
      });
      const event = await options.store.recordTaskEvent(options.context, task.id, "clarification.requested", {
        question: String(options.args.question),
        related_task_id: relatedTask?.id ?? null,
        urgency,
        rationale: typeof options.args.rationale === "string" ? options.args.rationale : null,
        summary: "Agent requested owner clarification."
      });
      return {
        executed: true,
        sideEffect: "local_persistence",
        result: {
          clarification_request_id: task.id,
          task_id: task.id,
          task_event_id: event.id,
          urgency
        }
      };
    }
    case "record_schedule_rationale": {
      const taskId = String(options.args.taskId);
      const task = await options.store.getTask(options.context, taskId);
      if (!task) {
        return {
          executed: false,
          sideEffect: "none",
          result: { reason: "task_not_found" }
        };
      }
      const updated = await options.store.updateTask(options.context, taskId, {
        scheduleRationale: String(options.args.rationale),
        sourceMemoryPath: typeof options.args.sourceMemoryPath === "string" ? options.args.sourceMemoryPath : task.sourceMemoryPath,
        sourceMessageId: typeof options.args.sourceMessageId === "string" ? options.args.sourceMessageId : task.sourceMessageId,
        sourceTaskId: typeof options.args.sourceTaskId === "string" ? options.args.sourceTaskId : task.sourceTaskId,
        recurrencePolicy: typeof options.args.recurrencePolicy === "string" ? options.args.recurrencePolicy : task.recurrencePolicy,
        nextReviewAt: typeof options.args.nextReviewAt === "string" ? options.args.nextReviewAt : task.nextReviewAt
      });
      const event = await options.store.recordTaskEvent(options.context, taskId, "task.schedule_rationale_recorded", {
        rationale: String(options.args.rationale),
        source_memory_path: updated?.sourceMemoryPath ?? null,
        source_message_id: updated?.sourceMessageId ?? null,
        source_task_id: updated?.sourceTaskId ?? null,
        recurrence_policy: updated?.recurrencePolicy ?? null,
        next_review_at: updated?.nextReviewAt ?? null,
        summary: "Agent recorded schedule rationale."
      });
      return {
        executed: Boolean(updated),
        sideEffect: "local_persistence",
        result: {
          task_id: taskId,
          task_event_id: event.id,
          rationale: updated?.scheduleRationale ?? null
        }
      };
    }
    case "record_observation":
      return {
        executed: true,
        sideEffect: "none",
        result: {
          recorded: true,
          source: options.args.source,
          summary: options.args.summary
        }
      };
    case "integration_action": {
      if (!options.settings) {
        return {
          executed: false,
          sideEffect: "none",
          result: { reason: "settings_required" }
        };
      }
      if (!options.integrationTokenProvider) {
        return {
          executed: false,
          sideEffect: "none",
          result: { reason: "integration_token_provider_required" }
        };
      }
      const response = await callIntegrationActionApi({
        settings: options.settings,
        context: options.context,
        actionId: options.args.actionId as IntegrationActionId,
        pathParams: asStringRecord(options.args.pathParams),
        query: asQueryRecord(options.args.query),
        body: options.args.body,
        tokenProvider: options.integrationTokenProvider,
        fetchImpl: options.fetchImpl
      });
      return {
        executed: response.ok,
        sideEffect: response.ok ? "cross_app_api" : "none",
        result: response.ok
          ? { status: response.status, data: response.data }
          : { reason: response.reason }
      };
    }
    default:
      return {
        executed: false,
        sideEffect: "none",
        result: { reason: "unsupported_tool" }
      };
  }
}

function excerpt(value: string | null | undefined, length: number): string {
  return (value ?? "").replace(/\s+/g, " ").trim().slice(0, length);
}

function configString(config: Record<string, unknown>, key: string): string | undefined {
  const value = config[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function channelFromSource(source: string | null | undefined): "email" | "sms" | "mms" {
  if (source === "sms") {
    return "sms";
  }
  if (source === "mms") {
    return "mms";
  }
  return "email";
}

async function resolveOwnerReplyDestination(options: {
  context: RequestContext;
  store: AgentStore;
  replyToMessage?: Pick<InboundMessageRecord, "fromAddr" | "source" | "subject">;
}): Promise<{ channel: "email" | "sms" | "mms"; toAddr: string; source: "inbound_owner_message" | "owner-contact" } | undefined> {
  const fromAddr = options.replyToMessage?.fromAddr?.trim();
  if (fromAddr && fromAddr.includes("@")) {
    return {
      channel: channelFromSource(options.replyToMessage?.source),
      toAddr: fromAddr,
      source: "inbound_owner_message"
    };
  }

  const ownerContact = await options.store.getConnector(options.context, "owner-contact");
  if (ownerContact?.status !== "enabled") {
    return undefined;
  }
  const smsGateway = configString(ownerContact.config, "sms_gateway");
  if (smsGateway) {
    return { channel: "sms", toAddr: smsGateway, source: "owner-contact" };
  }
  const mmsGateway = configString(ownerContact.config, "mms_gateway");
  if (mmsGateway) {
    return { channel: "mms", toAddr: mmsGateway, source: "owner-contact" };
  }
  const email = configString(ownerContact.config, "email");
  if (email) {
    return { channel: "email", toAddr: email, source: "owner-contact" };
  }
  return undefined;
}

function asStringRecord(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string") {
      result[key] = item;
    }
  }
  return result;
}

function asQueryRecord(value: unknown): Record<string, string | number | boolean> | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const result: Record<string, string | number | boolean> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string" || typeof item === "number" || typeof item === "boolean") {
      result[key] = item;
    }
  }
  return result;
}
