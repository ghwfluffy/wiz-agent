import type { InboundMessageRecord } from "../domain/types.js";

export type OwnerMessageIntent =
  | "memory_list_offload"
  | "task_creation"
  | "task_update"
  | "question_answer_request"
  | "approval_response"
  | "preference_correction"
  | "app_action_request"
  | "casual_conversation"
  | "clarification_response"
  | "unknown";

export type OwnerIntentEnvelope = {
  intent: OwnerMessageIntent;
  confidence: number;
  evidence: string[];
  guidance: string;
};

type Candidate = {
  intent: OwnerMessageIntent;
  confidence: number;
  evidence: string[];
};

function normalizeBody(value: string): string {
  return value
    .toLowerCase()
    .replace(/[“”]/g, "\"")
    .replace(/[’]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function clampConfidence(value: number): number {
  return Math.max(0, Math.min(0.99, Number(value.toFixed(2))));
}

function candidate(
  intent: OwnerMessageIntent,
  confidence: number,
  evidence: string[]
): Candidate {
  return {
    intent,
    confidence: clampConfidence(confidence),
    evidence: evidence.slice(0, 4)
  };
}

function exactApprovalCommand(body: string): Candidate | undefined {
  if (/^(yes|y|approve|approved|ok|okay|send it|do it|no|n|reject|cancel|stop|later|details)$/i.test(body)) {
    return candidate("approval_response", 0.84, ["short approval/review command shape"]);
  }
  if (/^edit\s+.{1,500}$/i.test(body)) {
    return candidate("approval_response", 0.86, ["edit command prefix"]);
  }
  return undefined;
}

function scorePreferenceCorrection(body: string): Candidate | undefined {
  const evidence: string[] = [];
  if (/\b(don't|do not|dont|never|stop|please don't|please do not)\b/.test(body)) {
    evidence.push("negative preference/correction wording");
  }
  if (/\b(that was not|that wasn't|not a task|just remember|something to remember|thing to remember|instead|use .+ for that|wrong|too early|too late|same thing twice)\b/.test(body)) {
    evidence.push("explicit correction phrase");
  }
  if (/\b(text|message|email|task|remember|memory|list|schedule|tool|app|goals|newsletter|preference)\b/.test(body)) {
    evidence.push("assistant behavior or storage target mentioned");
  }
  if (evidence.length >= 2) {
    return candidate("preference_correction", evidence.length >= 3 ? 0.82 : 0.72, evidence);
  }
  return undefined;
}

function scoreTaskUpdate(body: string): Candidate | undefined {
  const evidence: string[] = [];
  if (/\b(move|reschedule|push|postpone|delay|bump|mark|finish|finished|done|cancel|close|reopen|update)\b/.test(body)) {
    evidence.push("task update verb");
  }
  if (/\b(that|this|it|task|reminder|appointment|meeting|tomorrow|tonight|next week|later|today|due)\b/.test(body)) {
    evidence.push("existing work or schedule reference");
  }
  if (evidence.length === 2) {
    return candidate("task_update", 0.74, evidence);
  }
  return undefined;
}

function scoreMemoryListOffload(body: string): Candidate | undefined {
  const evidence: string[] = [];
  if (/\b(add|put|save|remember|keep|stash|file)\b/.test(body)) {
    evidence.push("memory/list preservation verb");
  }
  if (/\b(to|on|in)\s+(my\s+)?([a-z0-9 -]+\s+)?(list|bucket|ideas|queue)\b/.test(body)) {
    evidence.push("list/bucket target");
  }
  if (/\bone for\b|\bfor movie night\b|\bwatch list\b|\breading list\b|\bgift ideas?\b|\brestaurants?\b|\bbooks?\b|\bmovies?\b|\bthings to buy\b/.test(body)) {
    evidence.push("lightweight collection wording");
  }
  if (/\b(remind me|tomorrow|schedule|appointment|deadline|due)\b/.test(body)) {
    evidence.push("possible task wording lowers confidence");
  }
  if ((body.includes("?") || /^(what|when|where|who|why|how|which)\b/.test(body)) && evidence.length === 1 && evidence.includes("lightweight collection wording")) {
    return undefined;
  }
  if (evidence.includes("list/bucket target") || evidence.includes("lightweight collection wording")) {
    const hasTaskAmbiguity = evidence.includes("possible task wording lowers confidence");
    return candidate("memory_list_offload", hasTaskAmbiguity ? 0.58 : 0.8, evidence);
  }
  return undefined;
}

function scoreAppActionRequest(body: string): Candidate | undefined {
  const evidence: string[] = [];
  if (/\b(goals?|goal app|budget|fluffynomics|apartment gate|gate app|registered app)\b/.test(body)) {
    evidence.push("registered app mentioned");
  }
  if (/\b(add|create|record|update|open|use|put|log|sync|check)\b/.test(body)) {
    evidence.push("app action verb");
  }
  if (evidence.length === 2) {
    return candidate("app_action_request", 0.76, evidence);
  }
  return undefined;
}

function scoreTaskCreation(body: string): Candidate | undefined {
  const evidence: string[] = [];
  if (/\b(remind me to|reminder to|create a task|make a task|add a task|todo|to-do|follow up|schedule|set up)\b/.test(body)) {
    evidence.push("task creation phrase");
  }
  if (/\b(call|email|text|buy|book|schedule|check|find|send|draft|make|do)\b/.test(body)) {
    evidence.push("work/action verb");
  }
  if (/\b(tomorrow|today|tonight|next week|at \d|by \d|morning|afternoon|evening)\b/.test(body)) {
    evidence.push("future time cue");
  }
  if (evidence.includes("task creation phrase") || (evidence.includes("work/action verb") && evidence.includes("future time cue"))) {
    return candidate("task_creation", evidence.length >= 2 ? 0.76 : 0.68, evidence);
  }
  return undefined;
}

function scoreQuestionAnswer(body: string): Candidate | undefined {
  const evidence: string[] = [];
  if (body.includes("?")) {
    evidence.push("question mark");
  }
  if (/^(what|when|where|who|why|how|can you|could you|do you know|which)\b/.test(body)) {
    evidence.push("question opener");
  }
  if (/\b(what was|what's|remind me|do you remember|tell me)\b/.test(body)) {
    evidence.push("recall/answer wording");
  }
  if (evidence.length > 0) {
    return candidate("question_answer_request", evidence.length >= 2 ? 0.78 : 0.66, evidence);
  }
  return undefined;
}

function scoreClarification(body: string): Candidate | undefined {
  const evidence: string[] = [];
  if (/^(it'?s|its|that means|i mean|meaning|the answer is|answer:|use|pick|choose)\b/.test(body)) {
    evidence.push("answer/clarification opener");
  }
  if (/\b(the first one|the second one|mornings?|afternoons?|evenings?|yes, but|no, i mean)\b/.test(body)) {
    evidence.push("short clarification wording");
  }
  if (evidence.length > 0) {
    return candidate("clarification_response", evidence.length > 1 ? 0.68 : 0.56, evidence);
  }
  return undefined;
}

function scoreCasual(body: string): Candidate | undefined {
  if (/^(hi|hello|hey|thanks|thank you|lol|haha|nice|cool|sounds good|got it|ok thanks|okay thanks)[.! ]*$/.test(body)) {
    return candidate("casual_conversation", 0.7, ["short conversational acknowledgement"]);
  }
  return undefined;
}

function guidanceFor(intent: OwnerMessageIntent): string {
  switch (intent) {
    case "memory_list_offload":
      return "Host detected likely memory/list offload; verify before using personal list tools and do not create a task unless the owner asks for work.";
    case "task_creation":
      return "Host detected likely task creation; verify whether the owner is asking for future work before creating a task.";
    case "task_update":
      return "Host detected likely task update; verify the referenced task from context before changing status, schedule, or prompt.";
    case "question_answer_request":
      return "Host detected likely question/answer request; answer from available context or use read-only lookup tools before acting.";
    case "approval_response":
      return "Host detected likely approval-style response; host approval/trust handlers run before this prompt, so only reason about it if no host command matched.";
    case "preference_correction":
      return "Host detected likely owner correction/preference; consider record_owner_feedback and avoid automatic preference rewrites without a separate controlled action.";
    case "app_action_request":
      return "Host detected likely registered app action request; verify the app/action through capability tools and respect approval boundaries.";
    case "casual_conversation":
      return "Host detected likely casual conversation; prefer a lightweight observation or reply unless there is clear actionable content.";
    case "clarification_response":
      return "Host detected likely clarification response; connect it to recent waiting context before creating new work.";
    case "unknown":
      return "Host could not confidently classify owner intent; use model judgment and bounded context.";
  }
}

export function classifyOwnerMessageIntent(input: Pick<InboundMessageRecord, "bodyText" | "subject" | "source"> | string): OwnerIntentEnvelope {
  const rawBody = typeof input === "string" ? input : input.bodyText;
  const body = normalizeBody(rawBody);
  if (!body) {
    return {
      intent: "unknown",
      confidence: 0.1,
      evidence: ["empty body"],
      guidance: guidanceFor("unknown")
    };
  }

  const candidates = [
    exactApprovalCommand(body),
    scorePreferenceCorrection(body),
    scoreTaskUpdate(body),
    scoreMemoryListOffload(body),
    scoreAppActionRequest(body),
    scoreTaskCreation(body),
    scoreQuestionAnswer(body),
    scoreClarification(body),
    scoreCasual(body)
  ].filter((entry): entry is Candidate => Boolean(entry));

  const selected = candidates.sort((a, b) => b.confidence - a.confidence)[0] ?? candidate("unknown", 0.2, ["no deterministic heuristic matched"]);
  return {
    ...selected,
    guidance: guidanceFor(selected.intent)
  };
}

export function formatOwnerIntentEnvelope(envelope: OwnerIntentEnvelope): string {
  return [
    `intent: ${envelope.intent}`,
    `confidence: ${envelope.confidence.toFixed(2)}`,
    `evidence: ${envelope.evidence.length > 0 ? envelope.evidence.join("; ") : "none"}`,
    `guidance: ${envelope.guidance}`,
    "boundary: This host-detected envelope is context only. It must not create side effects by itself; verify before selecting tools."
  ].join("\n");
}
