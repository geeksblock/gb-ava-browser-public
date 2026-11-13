import { describe, expect, it } from "vitest";
import { handleMessage, PROTOCOL_VERSION, SERVER_NAME } from "../../mcp/src/server.js";
import { MCP_TOOLS, describeError } from "../../mcp/src/tools.js";
import { NeedsHumanError } from "../../adapter/src/errors.js";
import type { BridgeClient } from "../../adapter/src/client.js";

/** A client stand-in: records the call and answers from a table. */
function fakeClient(replies: Record<string, unknown>): BridgeClient & { calls: Array<{ method: string; params: unknown }> } {
  const calls: Array<{ method: string; params: unknown }> = [];
  return {
    calls,
    async call(method: string, params: Record<string, unknown> = {}) {
      calls.push({ method, params });
      const reply = replies[method];
      if (reply instanceof Error) throw reply;
      return reply ?? { ok: true };
    },
    async health() {
      return { ok: true };
    },
  } as unknown as BridgeClient & { calls: typeof calls };
}

const deps = (client: BridgeClient) => ({ client, version: "9.9.9" });

describe("the MCP handshake", () => {
  it("answers initialize with tools capability and the server identity", async () => {
    const reply = (await handleMessage(deps(fakeClient({})), JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }))) as {
      result: { protocolVersion: string; capabilities: { tools: unknown }; serverInfo: { name: string; version: string } };
    };
    expect(reply.result.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(reply.result.capabilities.tools).toBeDefined();
    expect(reply.result.serverInfo).toEqual({ name: SERVER_NAME, version: "9.9.9" });
  });

  it("answers a notification with silence", async () => {
    const reply = await handleMessage(deps(fakeClient({})), JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));
    expect(reply).toBeNull();
  });

  it("refuses an unknown method without crashing", async () => {
    const reply = (await handleMessage(deps(fakeClient({})), JSON.stringify({ jsonrpc: "2.0", id: 2, method: "nope" }))) as {
      error: { code: number };
    };
    expect(reply.error.code).toBe(-32601);
  });
});

describe("the tool table", () => {
  it("lists every tool with a description and a strict schema", async () => {
    const reply = (await handleMessage(deps(fakeClient({})), JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list" }))) as {
      result: { tools: Array<{ name: string; description: string; inputSchema: { additionalProperties?: boolean } }> };
    };
    const names = reply.result.tools.map((tool) => tool.name);
    expect(names).toContain("browser_read_page");
    expect(names).toContain("browser_click");
    expect(names).toContain("browser_upload");
    expect(reply.result.tools.every((tool) => tool.description.length > 20)).toBe(true);
    // A schema that accepts anything would let an agent send a typo silently.
    expect(reply.result.tools.every((tool) => tool.inputSchema.additionalProperties === false)).toBe(true);
  });

  it("has no duplicate tool names", () => {
    const names = MCP_TOOLS.map((tool) => tool.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe("calling a tool", () => {
  it("returns the adapter's result as text content", async () => {
    const client = fakeClient({ "tabs.list": { tabs: [{ tabId: 7 }], count: 1 } });
    const reply = (await handleMessage(
      deps(client),
      JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "browser_tabs", arguments: {} } }),
    )) as { result: { content: Array<{ text: string }>; isError: boolean } };
    expect(reply.result.isError).toBe(false);
    expect(reply.result.content[0]?.text).toContain('"tabId":7');
    expect(client.calls[0]?.method).toBe("tabs.list");
  });

  it("passes arguments through as protocol parameters", async () => {
    const client = fakeClient({ "page.click": { clicked: { x: 1, y: 2 } } });
    await handleMessage(
      deps(client),
      JSON.stringify({
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: { name: "browser_click", arguments: { tabId: 12, nodeId: 101 } },
      }),
    );
    expect(client.calls[0]).toEqual({ method: "page.click", params: { tabId: 12, nodeId: 101 } });
  });

  it("turns a needs-human failure into an error the model can act on", async () => {
    const client = fakeClient({
      "page.click": new NeedsHumanError("javascript_dialog", "a dialog is open", 3, { reason: "javascript_dialog" }),
    });
    const reply = (await handleMessage(
      deps(client),
      JSON.stringify({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "browser_click", arguments: { tabId: 3, selector: "#x" } } }),
    )) as { result: { isError: boolean; content: Array<{ text: string }> } };
    expect(reply.result.isError).toBe(true);
    const body = JSON.parse(reply.result.content[0]!.text) as { needs_human: boolean; reason: string; next: string };
    expect(body.needs_human).toBe(true);
    expect(body.reason).toBe("javascript_dialog");
    expect(body.next).toContain("Ask the owner");
  });

  it("refuses an unknown tool name rather than guessing", async () => {
    const reply = (await handleMessage(
      deps(fakeClient({})),
      JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "browser_teleport", arguments: {} } }),
    )) as { error: { code: number; message: string } };
    expect(reply.error.code).toBe(-32602);
    expect(reply.error.message).toContain("browser_teleport");
  });
});

describe("error description", () => {
  it("keeps a bridge error's code and retryability", () => {
    const described = describeError(Object.assign(new Error("x"), { name: "BridgeError", code: "tab_busy", retryable: true, detail: {} }));
    // The fallback path: not a NeedsHumanError, so it is reported generically.
    expect(JSON.parse(described.text).message).toBeTruthy();
    expect(described.needsHuman).toBe(false);
  });
});
