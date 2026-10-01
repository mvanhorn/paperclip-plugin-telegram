const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type PersistedSecretRef = {
  type: "secret_ref";
  secretId: string;
  version: "latest";
};

const SECRET_REF_CONFIG_KEYS = [
  "telegramBotTokenRef",
  "paperclipBoardApiTokenRef",
  "transcriptionApiKeyRef",
] as const;

function readSecretId(value: unknown): string {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return UUID_RE.test(trimmed) ? trimmed : "";
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const record = value as { type?: unknown; secretId?: unknown };
  if (record.type !== "secret_ref" || typeof record.secretId !== "string") return "";
  const secretId = record.secretId.trim();
  return UUID_RE.test(secretId) ? secretId : "";
}

/** UUID shown in the settings picker, from either a bare id or a secret_ref object. */
export function secretIdFromRef(value: unknown): string {
  return readSecretId(value);
}

/**
 * Shape Paperclip 2026.831+ persists for `format: "secret-ref"` config fields.
 * Empty values stay empty so optional fields are not sent as invalid objects.
 */
export function persistedSecretRef(value: unknown): PersistedSecretRef | "" {
  const secretId = readSecretId(value);
  if (!secretId) return "";
  return { type: "secret_ref", secretId, version: "latest" };
}

/** Rewrite the three secret-ref config fields into the object shape on save. */
export function withPersistedSecretRefs<T extends Record<string, unknown>>(config: T): T {
  const next: Record<string, unknown> = { ...config };
  for (const key of SECRET_REF_CONFIG_KEYS) {
    if (!(key in next)) continue;
    const persisted = persistedSecretRef(next[key]);
    if (persisted) next[key] = persisted;
  }
  return next as T;
}
