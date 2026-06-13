import type { Settings } from "../config/settings.js";
import type { AgentStore, InboundMessageRecord, RequestContext } from "../domain/types.js";
import { callIntegrationActionApi, type IntegrationTokenProvider } from "./integrationGateway.js";
import type { ToolName } from "./contracts.js";
import { createCrossAppApproval, createOutboundApproval } from "../security/approvalPolicy.js";
import { listAppCapabilities, type IntegrationActionId, type IntegrationAppId } from "../integrations/capabilityRegistry.js";
import { recordTaskOutcomeMemory } from "../memory/taskOutcomeMemory.js";

export type ToolExecutionResult = {
  executed: boolean;
  sideEffect: "none" | "local_persistence" | "cross_app_api";
  result: Record<string, unknown>;
};

function compactPayload(payload: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(payload).filter(([, value]) => value !== undefined));
}

function budgetContractPayload(args: Record<string, unknown>): Record<string, unknown> {
  return compactPayload({
    name: args.name,
    type: args.type,
    automatic: args.automatic,
    amount_cents: args.amountCents,
    organization: args.organization,
    linked_account_id: args.linkedAccountId,
    linked_wallet: args.linkedWallet,
    source_account_id: args.sourceAccountId,
    last_payment_date: args.lastPaymentDate,
    next_payment_date: args.nextPaymentDate,
    payment_period: args.paymentPeriod,
    payment_day: args.paymentDay,
    expiration_date: args.expirationDate,
    notes: args.notes,
    category: args.category,
    url: args.url,
    account_number: args.accountNumber,
    billing_day: args.billingDay
  });
}

function budgetExpensePayload(args: Record<string, unknown>): Record<string, unknown> {
  return compactPayload({
    name: args.name,
    category: args.category,
    notes: args.notes,
    estimated_amount_cents: args.estimatedAmountCents,
    linked_account_id: args.linkedAccountId,
    enabled: args.enabled,
    general_frequency: args.generalFrequency,
    last_expensed_date: args.lastExpensedDate,
    next_expensed_date: args.nextExpensedDate,
    next_date_is_static: args.nextDateIsStatic
  });
}

export async function executeToolCall(options: {
  context: RequestContext;
  store: AgentStore;
  runId?: string | null;
  toolName: ToolName;
  args: Record<string, unknown>;
  settings?: Settings;
  integrationTokenProvider?: IntegrationTokenProvider;
  fetchImpl?: typeof fetch;
  replyToMessage?: Pick<InboundMessageRecord, "fromAddr" | "source" | "subject">;
}): Promise<ToolExecutionResult> {
  const callReadIntegration = async (
    actionId: IntegrationActionId,
    input: {
      pathParams?: Record<string, string>;
      query?: Record<string, string | number | boolean>;
      body?: unknown;
    } = {}
  ): Promise<ToolExecutionResult> => {
    if (!options.settings || !options.integrationTokenProvider) {
      return {
        executed: false,
        sideEffect: "none",
        result: { reason: "integration_not_configured" }
      };
    }
    const result = await callIntegrationActionApi({
      settings: options.settings,
      context: options.context,
      actionId,
      pathParams: input.pathParams,
      query: input.query,
      body: input.body,
      tokenProvider: options.integrationTokenProvider,
      fetchImpl: options.fetchImpl
    });
    return {
      executed: result.ok,
      sideEffect: result.ok ? "cross_app_api" : "none",
      result: result.ok ? { status: result.status, data: result.data } : { reason: result.reason }
    };
  };

  const queueIntegrationApproval = async (
    actionId: IntegrationActionId,
    input: {
      pathParams?: Record<string, string>;
      query?: Record<string, string | number | boolean>;
      body?: unknown;
      summary: string;
    }
  ): Promise<ToolExecutionResult> => {
    const approval = await createCrossAppApproval({
      context: options.context,
      store: options.store,
      runId: options.runId ?? null,
      actionId,
      proposedPayload: {
        action_id: actionId,
        path_params: input.pathParams ?? {},
        query: input.query ?? {},
        body: input.body ?? null,
        user_intent_summary: input.summary
      },
      summary: input.summary
    });
    return {
      executed: true,
      sideEffect: "local_persistence",
      result: {
        approval_id: approval.id,
        status: "queued_approval",
        approval_required: true,
        action_id: actionId
      }
    };
  };

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
    case "get_recent_bot_activity": {
      const lookbackHours = typeof options.args.lookbackHours === "number" ? options.args.lookbackHours : 24 * 7;
      const limit = typeof options.args.limit === "number" ? options.args.limit : 10;
      const since = new Date(Date.now() - lookbackHours * 60 * 60 * 1000);
      const outbound = (await options.store.listOutboundMessages(options.context))
        .filter((message) => Date.parse(message.createdAt) >= since.getTime())
        .sort((a, b) => (b.sentAt ?? b.createdAt).localeCompare(a.sentAt ?? a.createdAt));
      const ownerInbound = (await options.store.listInboundMessages(options.context))
        .filter((message) => message.classification === "owner")
        .filter((message) => Date.parse(message.receivedAt ?? message.createdAt) >= since.getTime());
      const runs = (await options.store.listAgentRuns(options.context))
        .filter((run) => Date.parse(run.startedAt) >= since.getTime());
      const toolCalls = (await options.store.listToolCalls(options.context))
        .filter((toolCall) => Date.parse(toolCall.createdAt) >= since.getTime());
      const approvals = await options.store.listApprovals(options.context, ["pending"]);
      const sentOrPending = outbound.filter((message) =>
        ["requires_approval", "approved", "pending", "sending", "sent"].includes(message.status)
      );
      const failedRuns = runs.filter((run) => run.status === "failed");
      const failedToolCalls = toolCalls.filter((toolCall) => ["failed", "rejected"].includes(toolCall.status));
      const failedOutbound = outbound.filter((message) => message.status === "failed");
      const recentOutbound = outbound.slice(0, limit).map((message) => ({
        outbound_message_id: message.id,
        channel: message.channel,
        status: message.status,
        timestamp: message.sentAt ?? message.createdAt,
        subject: message.subject,
        body_excerpt: excerpt(message.bodyText, 280)
      }));
      return {
        executed: true,
        sideEffect: "none",
        result: {
          lookback_hours: lookbackHours,
          since: since.toISOString(),
          counts: {
            outbound_total: outbound.length,
            owner_visible_contact_attempts: sentOrPending.length,
            sent: outbound.filter((message) => message.status === "sent").length,
            pending_or_approved: outbound.filter((message) => ["pending", "approved", "sending"].includes(message.status)).length,
            requiring_approval: outbound.filter((message) => message.status === "requires_approval").length,
            failed_outbound: failedOutbound.length,
            owner_inbound_messages: ownerInbound.length,
            agent_runs: runs.length,
            failed_agent_runs: failedRuns.length,
            tool_calls: toolCalls.length,
            failed_or_rejected_tool_calls: failedToolCalls.length,
            pending_approvals: approvals.length
          },
          contact_cadence: assessContactCadence({
            lookbackHours,
            outboundAttempts: sentOrPending.length,
            ownerInboundCount: ownerInbound.length,
            pendingApprovals: approvals.length,
            failedOutbound: failedOutbound.length
          }),
          recent_outbound: recentOutbound,
          recent_failures: {
            outbound: failedOutbound.slice(0, limit).map((message) => ({
              outbound_message_id: message.id,
              timestamp: message.updatedAt,
              failure_message: message.failureMessage ?? null,
              body_excerpt: excerpt(message.bodyText, 160)
            })),
            agent_runs: failedRuns.slice(0, limit).map((run) => ({
              run_id: run.id,
              started_at: run.startedAt,
              failure_message: run.failureMessage ?? null
            })),
            tool_calls: failedToolCalls.slice(0, limit).map((toolCall) => ({
              tool_call_id: toolCall.id,
              tool_name: toolCall.toolName,
              status: toolCall.status,
              validation_error: toolCall.validationError ?? null
            }))
          },
          guidance: "Use this as operational context only. Do not contact the owner solely because this tool says contact has been quiet; consider task urgency, pending approvals, and owner preferences first."
        }
      };
    }
    case "list_app_capabilities": {
      const appId = typeof options.args.appId === "string" ? options.args.appId as IntegrationAppId : undefined;
      const includeActions = options.args.includeActions !== false;
      const apps = listAppCapabilities()
        .filter((app) => !appId || app.id === appId)
        .map((app) => ({
          id: app.id,
          display_name: app.displayName,
          app_purpose: app.appPurpose,
          user_value: app.userValue,
          data_sensitivity: app.dataSensitivity,
          base_url_setting: app.baseUrlSetting,
          auth_requirement: app.authRequirement,
          model_guidance: app.modelGuidance,
          action_count: app.actions.length,
          actions: includeActions ? app.actions.map((action) => ({
            id: action.id,
            title: action.title,
            access: action.access,
            risk: action.risk,
            method: action.method,
            path_template: action.pathTemplate,
            path_params: action.pathParams ?? [],
            query_params: action.queryParams ?? [],
            body_summary: action.bodySummary ?? null,
            purpose: action.purpose,
            when_to_use: action.whenToUse,
            safety: action.safety,
            response_use: action.responseUse
          })) : []
        }));
      return {
        executed: true,
        sideEffect: "none",
        result: { apps }
      };
    }
    case "list_goals":
      return callReadIntegration("goals.list_goals", {
        query: { include_archived: options.args.includeArchived === true }
      });
    case "create_goal":
      return queueIntegrationApproval("goals.create_goal", {
        body: compactPayload({
          goal_type: options.args.goalType,
          title: options.args.title,
          description: options.args.description,
          start_date: options.args.startDate,
          target_date: options.args.targetDate,
          target_value_number: options.args.targetValueNumber,
          target_value_date: options.args.targetValueDate,
          success_threshold_percent: options.args.successThresholdPercent,
          exception_dates: options.args.exceptionDates,
          checklist_items: options.args.checklistItems,
          metric_id: options.args.metricId,
          new_metric: options.args.newMetric && typeof options.args.newMetric === "object" ? compactPayload({
            name: (options.args.newMetric as Record<string, unknown>).name,
            metric_type: (options.args.newMetric as Record<string, unknown>).metricType,
            decimal_places: (options.args.newMetric as Record<string, unknown>).decimalPlaces,
            unit_label: (options.args.newMetric as Record<string, unknown>).unitLabel,
            initial_number_value: (options.args.newMetric as Record<string, unknown>).initialNumberValue,
            initial_date_value: (options.args.newMetric as Record<string, unknown>).initialDateValue,
            recorded_at: (options.args.newMetric as Record<string, unknown>).recordedAt
          }) : options.args.newMetric
        }),
        summary: String(options.args.userIntentSummary)
      });
    case "update_goal":
      return queueIntegrationApproval("goals.update_goal", {
        pathParams: { goal_id: String(options.args.goalId) },
        body: compactPayload({
          title: options.args.title,
          description: options.args.description,
          start_date: options.args.startDate,
          target_date: options.args.targetDate,
          target_value_number: options.args.targetValueNumber,
          target_value_date: options.args.targetValueDate,
          success_threshold_percent: options.args.successThresholdPercent,
          exception_dates: options.args.exceptionDates,
          checklist_items: options.args.checklistItems,
          archived: options.args.archived
        }),
        summary: String(options.args.userIntentSummary)
      });
    case "complete_goal_checklist_item":
      return queueIntegrationApproval("goals.complete_checklist_item", {
        pathParams: {
          goal_id: String(options.args.goalId),
          item_id: String(options.args.itemId)
        },
        body: { completed: options.args.completed !== false },
        summary: String(options.args.userIntentSummary)
      });
    case "list_goal_metrics":
      return callReadIntegration("goals.list_metrics", {
        query: { include_archived: options.args.includeArchived === true }
      });
    case "record_goal_metric_entry":
      return queueIntegrationApproval("goals.record_metric_entry", {
        pathParams: { metric_id: String(options.args.metricId) },
        body: compactPayload({
          number_value: options.args.numberValue,
          date_value: options.args.dateValue,
          recorded_at: options.args.recordedAt
        }),
        summary: String(options.args.userIntentSummary)
      });
    case "list_goal_notifications":
      return callReadIntegration("goals.list_notifications", {
        query: { timezone: String(options.args.timezone) }
      });
    case "complete_goal_notification":
      return queueIntegrationApproval("goals.complete_notification", {
        pathParams: { notification_id: String(options.args.notificationId) },
        body: compactPayload({
          timezone: options.args.timezone,
          number_value: options.args.numberValue,
          recorded_at: options.args.recordedAt
        }),
        summary: String(options.args.userIntentSummary)
      });
    case "list_budget_accounts":
      return callReadIntegration("budget.list_accounts");
    case "get_budget_account":
      return callReadIntegration("budget.get_account", {
        pathParams: { account_id: String(options.args.accountId) }
      });
    case "record_budget_account_value":
      return queueIntegrationApproval("budget.update_account_value", {
        pathParams: { account_id: String(options.args.accountId) },
        body: options.args.value,
        summary: String(options.args.userIntentSummary)
      });
    case "get_net_worth_history":
      return callReadIntegration("budget.get_net_worth_history");
    case "get_net_worth_forecast":
      return callReadIntegration("budget.get_net_worth_forecast", {
        query: typeof options.args.throughDate === "string" ? { through_date: options.args.throughDate } : {}
      });
    case "list_budget_transfers":
      return callReadIntegration("budget.list_transfers");
    case "list_budget_contracts":
      return callReadIntegration("budget.list_contracts");
    case "create_budget_contract":
      return queueIntegrationApproval("budget.create_contract", {
        body: budgetContractPayload(options.args),
        summary: String(options.args.userIntentSummary)
      });
    case "update_budget_contract":
      return queueIntegrationApproval("budget.update_contract", {
        pathParams: { contract_id: String(options.args.contractId) },
        body: budgetContractPayload(options.args),
        summary: String(options.args.userIntentSummary)
      });
    case "delete_budget_contract":
      return queueIntegrationApproval("budget.delete_contract", {
        pathParams: { contract_id: String(options.args.contractId) },
        summary: String(options.args.userIntentSummary)
      });
    case "list_budget_expenses":
      return callReadIntegration("budget.list_expenses");
    case "create_budget_expense":
      return queueIntegrationApproval("budget.create_expense", {
        body: budgetExpensePayload(options.args),
        summary: String(options.args.userIntentSummary)
      });
    case "update_budget_expense":
      return queueIntegrationApproval("budget.update_expense", {
        pathParams: { expense_id: String(options.args.expenseId) },
        body: budgetExpensePayload(options.args),
        summary: String(options.args.userIntentSummary)
      });
    case "delete_budget_expense":
      return queueIntegrationApproval("budget.delete_expense", {
        pathParams: { expense_id: String(options.args.expenseId) },
        summary: String(options.args.userIntentSummary)
      });
    case "list_budget_investments":
      return callReadIntegration("budget.list_investments");
    case "list_budget_audit_logs":
      return callReadIntegration("budget.list_audit_logs", {
        query: typeof options.args.limit === "number" ? { limit: options.args.limit } : {}
      });
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
    case "write_file": {
      const document = await options.store.writeMarkdownDocument(options.context, {
        path: String(options.args.path),
        markdown: String(options.args.content),
        expectedVersion: typeof options.args.expectedVersion === "number" ? options.args.expectedVersion : undefined
      });
      if ("code" in document) {
        return {
          executed: false,
          sideEffect: "none",
          result: document
        };
      }
      return {
        executed: true,
        sideEffect: "local_persistence",
        result: {
          markdown_document_id: document.id,
          path: document.path,
          version: document.version,
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
      if (updated && ["completed", "failed", "cancelled"].includes(updated.status)) {
        await recordTaskOutcomeMemory({
          store: options.store,
          context: options.context,
          taskId
        });
      }
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
      const destination = await resolveOwnerReplyDestination(options);
      if (!destination) {
        return {
          executed: false,
          sideEffect: "none",
          result: { reason: "owner_reply_destination_unavailable" }
        };
      }
      const { approval, outbound } = await createOutboundApproval({
        context: options.context,
        store: options.store,
        runId: options.runId ?? null,
        sourceRef: options.replyToMessage?.subject ?? null,
        channel: destination.channel,
        toAddr: destination.toAddr,
        subject: typeof options.args.subject === "string" ? options.args.subject : null,
        bodyText: String(options.args.body)
      });
      return {
        executed: true,
        sideEffect: "local_persistence",
        result: {
          approval_id: approval.id,
          outbound_message_id: outbound.id,
          status: "queued_approval",
          approval_required: true,
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
      const approval = await createCrossAppApproval({
        context: options.context,
        store: options.store,
        runId: options.runId ?? null,
        actionId: String(options.args.actionId),
        proposedPayload: {
          action_id: options.args.actionId,
          path_params: options.args.pathParams,
          query: options.args.query,
          body: options.args.body ?? null,
          user_intent_summary: options.args.userIntentSummary
        },
        summary: String(options.args.userIntentSummary)
      });
      return {
        executed: true,
        sideEffect: "local_persistence",
        result: {
          approval_id: approval.id,
          status: "queued_approval",
          approval_required: true,
          action_id: options.args.actionId
        }
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

function assessContactCadence(input: {
  lookbackHours: number;
  outboundAttempts: number;
  ownerInboundCount: number;
  pendingApprovals: number;
  failedOutbound: number;
}): Record<string, unknown> {
  const days = Math.max(input.lookbackHours / 24, 1 / 24);
  const attemptsPerDay = input.outboundAttempts / days;
  let level: "quiet" | "balanced" | "high" = "balanced";
  const reasons: string[] = [];
  if (attemptsPerDay > 3 || input.outboundAttempts >= 8) {
    level = "high";
    reasons.push("Owner-visible contact attempts are high for the selected window.");
  } else if (input.outboundAttempts === 0 && input.ownerInboundCount > 0) {
    level = "quiet";
    reasons.push("The owner has contacted the agent, but the agent has not attempted an owner-visible reply.");
  } else if (attemptsPerDay < 0.25 && input.ownerInboundCount > input.outboundAttempts) {
    level = "quiet";
    reasons.push("Owner inbound messages outnumber bot contact attempts in this window.");
  } else {
    reasons.push("Owner-visible contact attempts look moderate for the selected window.");
  }
  if (input.pendingApprovals > 0) {
    reasons.push("Pending approvals may make the agent look quiet even when it has proposed owner-visible messages.");
  }
  if (input.failedOutbound > 0) {
    reasons.push("Failed outbound messages may mean the owner did not actually receive attempted contact.");
  }
  return {
    level,
    outbound_attempts_per_day: Number(attemptsPerDay.toFixed(2)),
    owner_inbound_to_outbound_ratio: input.outboundAttempts === 0
      ? null
      : Number((input.ownerInboundCount / input.outboundAttempts).toFixed(2)),
    reasons
  };
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
