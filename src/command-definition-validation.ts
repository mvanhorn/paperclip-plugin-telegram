import type { WorkflowStep } from "./command-registry.js";

/**
 * `JSON.parse` returns `any`, so a `/commands import` payload that parses
 * cleanly but doesn't match the declared shape (e.g. `{"hello": 1}`) would
 * otherwise sail through as a `CustomCommand` with `name`/`steps` undefined —
 * failing later, inside `executeWorkflow`, with no link back to the bad
 * import. This module is the one place that shape gets checked before a
 * parsed value is trusted as a command definition.
 */
export type ImportedCommandDefinition = {
  name: string;
  description: string;
  steps: WorkflowStep[];
};

export type CommandDefinitionValidation =
  | { ok: true; definition: ImportedCommandDefinition }
  | { ok: false; error: string };

const VALID_STEP_TYPES = [
  "fetch_issue",
  "invoke_agent",
  "http_request",
  "send_message",
  "create_issue",
  "wait_approval",
  "set_state",
] as const;

const HTTP_METHODS = ["GET", "POST", "PUT", "DELETE"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((v) => typeof v === "string");
}

function isStepType(value: string): value is WorkflowStep["type"] {
  return (VALID_STEP_TYPES as readonly string[]).includes(value);
}

type StepResult = { ok: true; step: WorkflowStep } | { ok: false; error: string };

function validateStep(value: unknown, index: number): StepResult {
  const position = `Step ${index + 1}`;

  if (!isRecord(value)) {
    return { ok: false, error: `${position} must be an object.` };
  }

  const id = value.id;
  if (!isNonEmptyString(id)) {
    return { ok: false, error: `${position} must have an 'id' field.` };
  }
  const label = `${position} ('${id}')`;

  const type = value.type;
  if (!isNonEmptyString(type)) {
    return { ok: false, error: `${label} must have a 'type' field.` };
  }
  if (!isStepType(type)) {
    return { ok: false, error: `Invalid step type: '${type}' (${label}). Valid: ${VALID_STEP_TYPES.join(", ")}` };
  }

  const name = typeof value.name === "string" ? value.name : undefined;
  const base = { id, name };

  const missing = (field: string): StepResult => ({
    ok: false,
    error: `${label} of type '${type}' must have a '${field}' field.`,
  });
  const badType = (field: string, expected: string): StepResult => ({
    ok: false,
    error: `${label} of type '${type}': '${field}' must be ${expected}.`,
  });

  switch (type) {
    case "fetch_issue": {
      if (!isNonEmptyString(value.issueId)) return missing("issueId");
      return { ok: true, step: { ...base, type, issueId: value.issueId } };
    }

    case "invoke_agent": {
      if (!isNonEmptyString(value.agentId)) return missing("agentId");
      if (!isNonEmptyString(value.prompt)) return missing("prompt");
      return { ok: true, step: { ...base, type, agentId: value.agentId, prompt: value.prompt } };
    }

    case "http_request": {
      if (!isNonEmptyString(value.url)) return missing("url");
      const method = value.method;
      if (!(HTTP_METHODS as readonly string[]).includes(method as string)) {
        return badType("method", `one of ${HTTP_METHODS.join(", ")}`);
      }
      if (value.headers !== undefined && !isStringRecord(value.headers)) {
        return badType("headers", "an object of string values");
      }
      if (value.body !== undefined && typeof value.body !== "string") {
        return badType("body", "a string");
      }
      return {
        ok: true,
        step: {
          ...base,
          type,
          url: value.url,
          method: method as "GET" | "POST" | "PUT" | "DELETE",
          headers: value.headers,
          body: value.body,
        },
      };
    }

    case "send_message": {
      if (!isNonEmptyString(value.text)) return missing("text");
      return { ok: true, step: { ...base, type, text: value.text } };
    }

    case "create_issue": {
      if (!isNonEmptyString(value.title)) return missing("title");
      if (value.description !== undefined && typeof value.description !== "string") {
        return badType("description", "a string");
      }
      if (value.projectId !== undefined && typeof value.projectId !== "string") {
        return badType("projectId", "a string");
      }
      if (value.assigneeAgentId !== undefined && typeof value.assigneeAgentId !== "string") {
        return badType("assigneeAgentId", "a string");
      }
      return {
        ok: true,
        step: {
          ...base,
          type,
          title: value.title,
          description: value.description,
          projectId: value.projectId,
          assigneeAgentId: value.assigneeAgentId,
        },
      };
    }

    case "wait_approval": {
      if (!isNonEmptyString(value.prompt)) return missing("prompt");
      if (value.timeoutMs !== undefined && typeof value.timeoutMs !== "number") {
        return badType("timeoutMs", "a number");
      }
      return { ok: true, step: { ...base, type, prompt: value.prompt, timeoutMs: value.timeoutMs } };
    }

    case "set_state": {
      if (!isNonEmptyString(value.key)) return missing("key");
      if (typeof value.value !== "string") return missing("value");
      return { ok: true, step: { ...base, type, key: value.key, value: value.value } };
    }
  }
}

/**
 * Validates a `JSON.parse`d value against the `CustomCommand` shape before
 * anything downstream (storage, then `executeWorkflow`) trusts it. Every
 * `steps[]` entry is checked against its declared `type`'s required fields,
 * not just the `id`/`type` pair — a `send_message` step missing `text`, or an
 * `http_request` step with a non-string `body`, is rejected here rather than
 * failing mid-run with no link back to the import.
 */
export function validateCommandDefinition(parsed: unknown): CommandDefinitionValidation {
  if (!isRecord(parsed)) {
    return { ok: false, error: "Command definition must be a JSON object with 'name' and 'steps' fields." };
  }

  if (!isNonEmptyString(parsed.name)) {
    return { ok: false, error: "Command definition must have a 'name' field." };
  }

  if (parsed.description !== undefined && typeof parsed.description !== "string") {
    return { ok: false, error: "Command definition 'description' must be a string." };
  }

  if (!Array.isArray(parsed.steps)) {
    return { ok: false, error: "Command definition must have a 'steps' array field." };
  }

  const steps: WorkflowStep[] = [];
  for (let i = 0; i < parsed.steps.length; i++) {
    const result = validateStep(parsed.steps[i], i);
    if (!result.ok) return { ok: false, error: result.error };
    steps.push(result.step);
  }

  return {
    ok: true,
    definition: {
      name: parsed.name,
      description: typeof parsed.description === "string" ? parsed.description : "No description",
      steps,
    },
  };
}
