import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { startWorkerRpcHost } from "@paperclipai/plugin-sdk";
import manifest from "../src/manifest.js";

type Rpc = { jsonrpc: "2.0"; id?: string | number; method?: string; params?: any; result?: any; error?: any; paperclipInvocationId?: string };

/** Real SDK transport/AsyncLocalStorage, with a deliberately small fake host.
 * Scope admission mirrors worker-manager.contextForWorkerMessage and SDK
 * host-client-factory.requireInvocationCompanyScope: instance state has no
 * company gate, expired IDs fail, proactive calls need an explicit admitted ID.
 */
describe("polling invocation lifetime", () => {
  it("handles connect/status after config expiry while another company's delivery is live", async () => {
    vi.resetModules();
    const { plugin } = await import("../src/worker.js");
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const active = new Map<string, string>();
    const configured = new Set(["company-a"]);
    const calls: Rpc[] = [];
    const failures: string[] = [];
    const sent: Array<{ chat_id: string; text: string }> = [];
    const state = new Map<string, unknown>();
    const pending = new Map<string, (reply: Rpc) => void>();
    const polls: Rpc[] = [];
    const companies = [
      { id: "company-a", name: "Company A" },
      { id: "company-b", name: "Company B" },
      { id: "company-c", name: "Company C" },
    ];
    const config = { telegramBotTokenRef: "test-reference", enableCommands: true, enableInbound: true };
    let heldDelivery: Rpc | undefined;
    let deliveryB: Promise<Rpc> | undefined;
    let sequence = 0;
    let buffer = "";
    const reply = (request: Rpc, result: unknown) => stdin.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\n");
    const stateKey = (p: any) => JSON.stringify([p.scopeKind, p.scopeId, p.namespace, p.stateKey]);
    const httpReply = (request: Rpc, result: unknown) => reply(request, { status: 200, headers: {}, body: JSON.stringify({ ok: true, result }) });
    const handle = (request: Rpc) => {
      if (!request.method) {
        pending.get(String(request.id))?.(request);
        return;
      }
      if (request.id === undefined) return;
      calls.push(request);
      const p = request.params ?? {};
      const wildcard = request.method === "companies.list";
      const companyId = p.companyId ?? (p.scopeKind === "company" ? p.scopeId : undefined);
      const invocation = request.paperclipInvocationId;
      const allowed = invocation ? active.get(invocation) : companyId && configured.has(companyId) ? companyId : undefined;
      const invalid = invocation ? !active.has(invocation) : !allowed && active.size > 0;
      if ((wildcard || companyId) && (invalid || (!wildcard && allowed !== companyId))) {
        failures.push(`${request.method}:${invocation ?? "proactive"}:${companyId ?? "wildcard"}`);
        stdin.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32000, message: "missing, expired, or unknown invocation scope" } }) + "\n");
        return;
      }
      if (request.method === "companies.list" && invocation === "delivery-b") {
        heldDelivery = request;
        return;
      }
      switch (request.method) {
        case "companies.list": reply(request, companies.filter((c) => c.id === allowed)); break;
        case "companies.get": reply(request, companies.find((c) => c.id === p.companyId) ?? null); break;
        case "config.get": reply(request, config); break;
        case "secrets.resolve": reply(request, "test-token"); break;
        case "state.get": reply(request, state.get(stateKey(p)) ?? null); break;
        case "state.set": state.set(stateKey(p), p.value); reply(request, null); break;
        case "agents.list": reply(request, [{ id: "agent-a", status: "running" }]); break;
        case "issues.list": reply(request, []); break;
        case "http.fetch": {
          if (p.url.includes("/getUpdates")) { polls.push(request); break; }
          if (p.url.endsWith("/sendMessage")) sent.push(JSON.parse(p.init.body));
          httpReply(request, p.url.endsWith("/sendMessage") ? { message_id: sent.length } : true);
          break;
        }
        default: reply(request, null);
      }
    };
    stdout.on("data", (chunk) => {
      buffer += String(chunk);
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line) handle(JSON.parse(line));
      }
    });
    const host = startWorkerRpcHost({ plugin, stdin, stdout });
    const call = (method: string, params: unknown, invocation?: { id: string; companyId: string }) => {
      const id = `host-${++sequence}`;
      if (invocation) active.set(invocation.id, invocation.companyId);
      return new Promise<Rpc>((resolve) => {
        pending.set(id, (result) => {
          pending.delete(id);
          if (invocation) active.delete(invocation.id);
          resolve(result);
        });
        stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params, ...(invocation ? { paperclipInvocation: invocation } : {}) }) + "\n");
      });
    };
    let updateId = 0;
    const deliverUpdates = (request: Rpc, commands: string[], chatId = 111) => httpReply(request, commands.map((text) => ({
      update_id: ++updateId,
      message: { message_id: updateId, chat: { id: chatId, type: "private" }, from: { id: 123 }, text, entities: [{ type: "bot_command", offset: 0, length: text.split(" ")[0]!.length }] },
    })));
    try {
      expect((await call("initialize", { manifest, config: {} })).error).toBeUndefined();
      expect((await call("configChanged", { config }, { id: "delivery-a", companyId: "company-a" })).error).toBeUndefined();
      expect(active.has("delivery-a")).toBe(false);
      await vi.waitFor(() => expect(polls).toHaveLength(1));
      const cutoff = calls.length;
      deliveryB = call("configChanged", { config }, { id: "delivery-b", companyId: "company-b" });
      await vi.waitFor(() => expect(heldDelivery).toBeDefined());
      deliverUpdates(polls.shift()!, ["/connect Company A", "/status", "/connect Company C"]);
      await vi.waitFor(() => expect(polls).toHaveLength(1));
      expect(active.has("delivery-b")).toBe(true);
      const background = calls.slice(cutoff).filter((c) => c.paperclipInvocationId !== "delivery-b");
      expect(background.flatMap((c) => c.paperclipInvocationId ? [`${c.method}:${c.paperclipInvocationId}`] : [])).toEqual([]);
      expect(background.filter((c) => c.method === "companies.list")).toEqual([]);
      expect(background.filter((c) => c.method === "companies.get").map((c) => c.params.companyId)).toEqual(["company-a", "company-a"]);
      expect(background.find((c) => c.method === "agents.list")?.params.companyId).toBe("company-a");
      expect(background.find((c) => c.method === "issues.list")?.params.companyId).toBe("company-a");
      expect(sent.some((m) => m.text.includes("running"))).toBe(true);
      expect(sent.some((m) => m.text.includes('Company "Company C" not found. Available: Company A'))).toBe(true);
      expect(failures).toEqual([]);
      configured.add("company-b");
      reply(heldDelivery!, companies.filter((c) => c.id === "company-b"));
      heldDelivery = undefined;
      await deliveryB;
      const afterB = calls.length;
      deliverUpdates(polls.shift()!, ["/connect Company B", "/status"], 222);
      await vi.waitFor(() => expect(polls).toHaveLength(1));
      const companyBCalls = calls.slice(afterB);
      expect(companyBCalls.every((c) => c.paperclipInvocationId === undefined)).toBe(true);
      expect(companyBCalls.find((c) => c.method === "agents.list")?.params.companyId).toBe("company-b");
      expect(companyBCalls.find((c) => c.method === "issues.list")?.params.companyId).toBe("company-b");
      expect(sent.some((m) => String(m.chat_id) === "222" && m.text.includes("running"))).toBe(true);
      expect(companyBCalls.some((c) => c.params?.companyId === "company-c")).toBe(false);

      // Previously delivered scopes are not permanent grants: host revocation
      // must exclude B from the menu, without leaking its old name or linking.
      configured.delete("company-b");
      deliverUpdates(polls.shift()!, ["/connect Company B"], 333);
      await vi.waitFor(() => expect(polls).toHaveLength(1));
      expect(sent.some((m) => String(m.chat_id) === "333" && m.text === 'Company "Company B" not found. Available: Company A')).toBe(true);
      expect([...state.entries()].some(([key]) => key.includes("chat_333"))).toBe(false);
    } finally {
      if (heldDelivery) {
        reply(heldDelivery, []);
        await deliveryB;
      }
      await call("onEvent", { event: { eventType: "plugin.stopping" } });
      for (const poll of polls.splice(0)) httpReply(poll, []);
      // Let the stopped poll consume its final response before closing RPC.
      await new Promise<void>((resolve) => setImmediate(resolve));
      host.stop();
      stdin.destroy();
      stdout.destroy();
    }
  });
});
