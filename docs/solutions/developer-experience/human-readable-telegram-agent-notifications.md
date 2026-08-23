---
title: Make Telegram agent notifications human-readable
date: 2026-07-08
category: developer-experience
module: paperclip-plugin-telegram
problem_type: developer_experience
component: tooling
severity: medium
applies_when:
  - Telegram or chat notifications render agent lifecycle events with opaque identifiers or noisy started/finished messages.
symptoms:
  - Direct message feed fills with agent run started and finished notifications.
  - Primary notification label is a full UUID instead of a human-readable agent name.
  - Lifecycle event noise hides useful status updates.
tags: [telegram, notifications, agents, uuid-fallback, developer-experience]
---

# Make Telegram agent notifications human-readable

## Context

Paperclip Telegram notifications used raw agent identifiers as primary message text. In live chat, Second Vector Board notifications showed full UUID values such as `287196d3-6e28-4094-80cd-e7a3710b2ba1` before lifecycle copy like `started a new run`, `completed successfully`, and `Pi exited with code 143`.

That made Telegram direct messages noisy and hard to scan. The useful information was the agent status, but the first thing the user had to parse was a 36-character machine identifier. The problem was amplified because routine run-start and run-finish events outnumber actionable failures.

## Guidance

Normalize agent display at the formatter boundary. Do not let raw UUID-like values reach user-facing Telegram copy.

Use small helper functions in the formatter layer:

```ts
function isUuidLike(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function displayAgentName(value: string): string {
  return isUuidLike(value) ? `Agent ${value.slice(0, 8)}` : value;
}
```

Apply the helper everywhere an agent label appears in Telegram user copy:

```ts
formatAgentError(event);
formatAgentRunStarted(event);
formatAgentRunFinished(event);
```

Keep lifecycle copy compact:

```ts
`${displayAgentName(agentName)} started run`;
`✅ ${displayAgentName(agentName)} completed run`;
```

Avoid reintroducing verbose lifecycle language such as `started a new run` or `completed successfully`. Those phrases read like chat spam when many agents run.

Document defaults clearly in README:

- run-start notifications are optional
- run-finish notifications are optional
- both are disabled by default
- agent errors use human-readable labels, including shortened UUID fallback

Operational note: if a live install uses an older package than branch source, patch built `dist/` only as a temporary hotfix, then replace it with a proper package build or deploy as soon as possible.

## Why This Matters

Telegram DM is a high-interruption channel. Full UUID as headline forces the user to parse machine identity before understanding event meaning. Repeated lifecycle notices amplify the problem because routine starts and finishes outnumber actionable failures.

A short fallback like `Agent 287196d3` preserves correlation value without flooding the UI with opaque IDs. Keeping lifecycle notifications disabled by default reserves chat for higher-signal updates. Errors still surface with enough identity to debug.

Formatter-level fallback also protects every notification path. Worker-side enrichment can improve labels when `agentName` is available, but formatter fallback prevents raw UUID leakage when metadata is missing or an older event shape reaches the formatter.

## When to Apply

- User-facing notifications include agent IDs, run IDs, task IDs, or machine-generated UUIDs.
- Display names may be missing and fallback comes from an internal identifier.
- Chat, push, SMS, or desktop notifications show repeated lifecycle events.
- Operational hotfix patches live `dist/` while source branch carries the durable fix.

Do not apply this rule to audit logs, machine APIs, or copy/paste debugging surfaces where the full identifier is the useful data. In those cases, keep the full ID in metadata, logs, or expandable details, not primary notification text.

## Examples

Before:

```text
287196d3-6e28-4094-80cd-e7a3710b2ba1 started a new run
287196d3-6e28-4094-80cd-e7a3710b2ba1 completed successfully
287196d3-6e28-4094-80cd-e7a3710b2ba1 Pi exited with code 143
```

After:

```text
Agent 287196d3 started run
✅ Agent 287196d3 completed run
Agent 287196d3 Pi exited with code 143
```

Regression test intent:

```ts
it("does not expose full UUID fallback in agent error copy", () => {
  const message = formatAgentError({
    agentName: "287196d3-6e28-4094-80cd-e7a3710b2ba1",
  });

  expect(message).toContain("Agent 287196d3");
  expect(message).not.toContain("287196d3-6e28-4094-80cd-e7a3710b2ba1");
});

it("uses compact lifecycle copy", () => {
  expect(formatAgentRunStarted(event)).toContain("started run");
  expect(formatAgentRunStarted(event)).not.toContain("started a new run");
  expect(formatAgentRunFinished(event)).toContain("completed run");
  expect(formatAgentRunFinished(event)).not.toContain("completed successfully");
});
```

Verification used for the fixed branch:

```sh
npm run typecheck
npm test
npm run build
```

Live hotfix verification used:

```sh
node --check dist/formatters.js
node --check dist/worker.js
```

Observed validation:

- `npm test`: 224 tests passed; existing duplicate-key warning remained in `tests/commands.test.ts`.
- Synthetic formatter output included `Agent 287196d3` rather than the full UUID.
- Paperclip Mesh health returned `status=ok`.
- Independent reviewer subagent returned no findings.

## Related

- `src/formatters.ts`: `isUuidLike()`, `displayAgentName()`, and Telegram message formatting.
- `tests/formatters.test.ts`: UUID fallback and lifecycle copy regression tests.
- `README.md`: lifecycle notification defaults and human-readable error labels.
- Config flags: `notifyOnAgentRunStarted` and `notifyOnAgentRunFinished` default false.
- Upstream PR: https://github.com/mvanhorn/paperclip-plugin-telegram/pull/67
