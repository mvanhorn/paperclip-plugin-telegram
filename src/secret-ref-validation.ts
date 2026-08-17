export type SecretRefConfig = {
  telegramBotTokenRef?: unknown;
  paperclipBoardApiTokenRef?: unknown;
  transcriptionApiKeyRef?: unknown;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const FIELDS = [
  { key: "telegramBotTokenRef", required: true },
  { key: "paperclipBoardApiTokenRef", required: false },
  { key: "transcriptionApiKeyRef", required: false },
] as const;

/**
 * A secret reference, in either shape a Paperclip host may use.
 *
 * Older hosts take a bare secret UUID string. Current hosts require an object
 * `{ type: "secret_ref", secretId, version? }` and reject the bare string, so
 * both must be accepted or the plugin is unconfigurable on one of them.
 */
export type SecretRef = string | { type: "secret_ref"; secretId: string; version?: number };

export function isValidSecretRef(value: unknown): value is SecretRef {
  if (typeof value === "string") return UUID_RE.test(value.trim());
  if (typeof value === "object" && value !== null) {
    const record = value as { type?: unknown; secretId?: unknown };
    return (
      record.type === "secret_ref" &&
      typeof record.secretId === "string" &&
      UUID_RE.test(record.secretId.trim())
    );
  }
  return false;
}

function describeBadValue(value: unknown): string {
  if (value === undefined || value === null) return "<empty>";
  if (typeof value === "object") return "<object>";
  if (typeof value !== "string") return `<${typeof value}>`;
  const trimmed = value.trim();
  if (trimmed.length === 0) return "<empty string>";
  // Truncate to avoid leaking long pasted secrets into error logs.
  const sample = trimmed.length > 16 ? `${trimmed.slice(0, 12)}…` : trimmed;
  return `"${sample}"`;
}

function fieldError(key: string, value: unknown): string {
  return [
    `${key} must be the UUID of a Paperclip secret`,
    `(format 8-4-4-4-12, e.g. "12f7ed4a-1234-4d0c-9abc-bd58d44d15e1").`,
    `Got ${describeBadValue(value)}.`,
    `Create the secret first via POST /api/companies/{id}/secrets and paste the returned "id" value here —`,
    `not the raw token, the whole JSON response, or any other identifier.`,
  ].join(" ");
}

export function validateSecretRefFields(config: SecretRefConfig): string[] {
  const errors: string[] = [];
  for (const { key, required } of FIELDS) {
    const value = config[key];
    const isMissing =
      value === undefined ||
      value === null ||
      (typeof value === "string" && value.trim().length === 0);

    if (isMissing) {
      if (required) errors.push(`${key} is required.`);
      continue;
    }

    if (!isValidSecretRef(value)) {
      errors.push(fieldError(key, value));
    }
  }
  return errors;
}
