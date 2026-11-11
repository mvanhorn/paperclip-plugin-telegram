import type { PluginToolDeclaration } from "@paperclipai/shared";

export const telegramTools = {
  escalate_to_human: {
    riskLevel: "write",
    displayName: "Escalate to Human",
    description: "Escalate a conversation to a human when you cannot handle it confidently",
    parametersSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        reason: {
          type: "string",
          enum: ["low_confidence", "explicit_request", "policy_violation", "unknown_intent"],
          description: "Why this conversation needs human attention",
        },
        conversationSummary: {
          type: "string",
          description: "Brief summary of the conversation context and what the user needs",
        },
        suggestedActions: {
          type: "array",
          items: { type: "string" },
          description: "Suggested actions the human responder could take",
        },
        suggestedReply: {
          type: "string",
          description: "A draft reply the human can send or modify",
        },
        confidenceScore: {
          type: "number",
          minimum: 0,
          maximum: 1,
          description: "How confident the agent is (0-1). Lower values indicate greater need for human help",
        },
        originChatId: { type: "string" },
        originThreadId: { type: "string" },
        originMessageId: { type: "string" },
        sessionId: { type: "string", description: "Session ID for routing reply back" },
        transport: { type: "string", enum: ["native", "acp"], description: "Transport type for reply routing" },
      },
      required: ["reason", "conversationSummary"],
    },
  },
  handoff_to_agent: {
    riskLevel: "write",
    displayName: "Handoff to Agent",
    description: "Hand off work to another agent in this thread",
    parametersSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        targetAgent: { type: "string", description: "Name of agent to hand off to" },
        reason: { type: "string", description: "Why you're handing off" },
        contextSummary: { type: "string", description: "Summary for the target agent" },
        requiresApproval: { type: "boolean", default: true, description: "Wait for human approval before target starts" },
        chatId: { type: "string", description: "Telegram chat ID" },
        threadId: { type: "number", description: "Telegram thread ID" },
      },
      required: ["targetAgent", "reason", "contextSummary"],
    },
  },
  discuss_with_agent: {
    riskLevel: "write",
    displayName: "Discuss with Agent",
    description: "Start a back-and-forth conversation with another agent",
    parametersSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        targetAgent: { type: "string", description: "Name of agent to discuss with" },
        topic: { type: "string", description: "Discussion topic" },
        initialMessage: { type: "string", description: "First message to send" },
        maxTurns: { type: "number", default: 10, description: "Maximum conversation turns" },
        humanCheckpointAt: { type: "number", description: "Pause for human approval at this turn" },
        chatId: { type: "string", description: "Telegram chat ID" },
        threadId: { type: "number", description: "Telegram thread ID" },
      },
      required: ["targetAgent", "topic", "initialMessage"],
    },
  },
  register_watch: {
    riskLevel: "write",
    displayName: "Register Watch",
    description: "Register a proactive watch that monitors entities and sends suggestions",
    parametersSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        name: { type: "string", description: "Name of the watch" },
        description: { type: "string", description: "What this watch monitors" },
        entityType: { type: "string", enum: ["issue", "agent", "company", "custom"], description: "Type of entity to watch" },
        conditions: {
          type: "array",
          items: {
            type: "object",
            properties: {
              field: { type: "string" },
              operator: { type: "string", enum: ["gt", "lt", "eq", "ne", "contains", "exists"] },
              value: {},
            },
            required: ["field", "operator", "value"],
          },
          description: "Conditions that trigger the watch",
        },
        template: { type: "string", description: "Message template with {{field}} placeholders" },
        builtinTemplate: { type: "string", enum: ["invoice-overdue", "lead-stale"], description: "Use a built-in template instead" },
        chatId: { type: "string", description: "Telegram chat ID for suggestions" },
        threadId: { type: "number", description: "Telegram thread ID for suggestions" },
      },
      required: ["chatId"],
    },
  },
} satisfies Record<string, Omit<PluginToolDeclaration, "name"> & {
  riskLevel: "write";
}>;
