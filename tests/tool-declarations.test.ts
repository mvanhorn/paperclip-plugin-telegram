import { describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import manifest from "../src/manifest.js";

vi.mock("@paperclipai/plugin-sdk", async () => {
  const actual = await vi.importActual("@paperclipai/plugin-sdk");
  return { ...actual, runWorker: vi.fn() };
});

const requiredInputs = [
  ["escalate_to_human", ["reason", "conversationSummary"]],
  ["handoff_to_agent", ["targetAgent", "reason", "contextSummary"]],
  ["discuss_with_agent", ["targetAgent", "topic", "initialMessage"]],
  ["register_watch", ["chatId"]],
] as const;

describe("agent tool declarations", () => {
  it.each(requiredInputs)("advertises the inputs and effects of %s", (name, required) => {
    const declaration = manifest.tools!.find((tool) => tool.name === name)!;
    expect(declaration.parametersSchema).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: [...required],
    });
    const properties = declaration.parametersSchema.properties as Record<string, unknown>;
    for (const field of required) expect(properties).toHaveProperty(field);
    expect(declaration).toMatchObject({ riskLevel: "write" });
  });

  it("registers the same declarations that the host discovers from the manifest", async () => {
    const { plugin } = await import("../src/worker.js");
    const register = vi.fn();
    const ctx = {
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      events: { on: vi.fn() },
      jobs: { register: vi.fn() },
      tools: { register },
      actions: { register: vi.fn() },
      data: { register: vi.fn() },
    } as unknown as PluginContext;
    await plugin.definition.setup(ctx);
    expect(register).toHaveBeenCalledTimes(manifest.tools!.length);
    for (const { name, ...declaration } of manifest.tools!) {
      const call = register.mock.calls.find(([toolName]) => toolName === name)!;
      expect(call).toBeDefined();
      expect(call[1]).toEqual(declaration);
      expect(call[2]).toEqual(expect.any(Function));
    }
  });
});
