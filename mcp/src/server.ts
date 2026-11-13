/**
 * A stdio MCP server over the adapter.
 *
 * JSON-RPC 2.0, one message per line, as the MCP stdio transport specifies. The
 * server owns no policy: it lists the tools, forwards a call to the adapter, and
 * returns the result or an error the model can act on (a `needs_human` answer is
 * an error with the reason spelled out, never a retry).
 *
 * `handleMessage` is a pure function of (message, client) so the protocol can be
 * unit-tested without a process, and `runStdio` is the ten lines of plumbing that
 * a real client uses.
 */

import { createInterface } from "node:readline";
import type { BridgeClient } from "../../adapter/src/index.js";
import { MCP_TOOLS, describeError } from "./tools.js";

export const PROTOCOL_VERSION = "2024-11-05";
export const SERVER_NAME = "gb-ava-browser";
export const SERVER_VERSION = "0.1.0";

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

export interface ServerDeps {
  client: BridgeClient;
  /** Injected for tests; defaults to the package version. */
  version?: string;
}

type Reply = Record<string, unknown> | null;

function ok(id: unknown, result: unknown): Reply {
  return { jsonrpc: "2.0", id: id ?? null, result };
}

function fail(id: unknown, code: number, message: string, data?: unknown): Reply {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message, ...(data === undefined ? {} : { data }) } };
}

/**
 * One message in, at most one message out. A notification (no id) produces no
 * reply, which is what the transport expects.
 */
export async function handleMessage(deps: ServerDeps, raw: string): Promise<Reply> {
  let message: JsonRpcRequest;
  try {
    message = JSON.parse(raw) as JsonRpcRequest;
  } catch {
    return fail(null, -32700, "parse error");
  }
  if (message === null || typeof message !== "object") return fail(null, -32600, "invalid request");

  const { id, method, params } = message;

  if (method === "initialize") {
    return ok(id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: SERVER_NAME, version: deps.version ?? SERVER_VERSION },
      instructions:
        "Drives the owner's real, already-signed-in Chrome in the background. Call browser_tabs first for a tab id, then browser_read_page to see the page, then act with the node ids it returned. " +
        "To reach a page nobody has open, call browser_create_tab: it opens in the background by default, so the owner is not interrupted. " +
        "A needs_human error means a person must act — ask, do not retry. " +
        "An invalid_request naming a matchCount means your selector matched several controls: read detail.matches and make the selector specific, rather than repeating the call.",
    });
  }

  if (method === "notifications/initialized" || method === "notifications/cancelled") return null;

  if (method === "ping") return ok(id, {});

  if (method === "tools/list") {
    return ok(id, {
      tools: MCP_TOOLS.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      })),
    });
  }

  if (method === "tools/call") {
    const name = typeof params?.["name"] === "string" ? (params["name"] as string) : "";
    const args = (params?.["arguments"] ?? {}) as Record<string, unknown>;
    const tool = MCP_TOOLS.find((entry) => entry.name === name);
    if (tool === undefined) return fail(id, -32602, `unknown tool: ${name}`);
    // Hold the host to the schema we advertise. Without this, a `null` for a string
    // parameter reaches `String(args[...])` and is sent to the bridge as the literal
    // "null" — a value the caller never meant (#33 item 4). The bridge would refuse
    // it, but as `invalid_request` for a well-formed tool call, which misplaces the
    // blame.
    const schemaProblem = checkAgainstSchema(tool.inputSchema, args);
    if (schemaProblem !== null) {
      return ok(id, {
        content: [{ type: "text", text: JSON.stringify({ code: "invalid_request", message: schemaProblem }) }],
        isError: true,
      });
    }
    try {
      const result = await tool.handler({ client: deps.client }, args);
      return ok(id, {
        content: [{ type: "text", text: JSON.stringify(result) }],
        isError: false,
      });
    } catch (error) {
      const described = describeError(error);
      return ok(id, {
        content: [{ type: "text", text: described.text }],
        isError: true,
      });
    }
  }

  return fail(id, -32601, `method not found: ${String(method)}`);
}

/** The stdio loop a real MCP client drives. */
export function runStdio(deps: ServerDeps): void {
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const write = (reply: Reply): void => {
    if (reply === null) return;
    process.stdout.write(`${JSON.stringify(reply)}\n`);
  };

  lines.on("line", (line) => {
    const trimmed = line.trim();
    if (trimmed.length === 0) return;
    void handleMessage(deps, trimmed).then(write, (error: unknown) => {
      write(fail(null, -32603, error instanceof Error ? error.message : "internal error"));
    });
  });
}

/**
 * A deliberately small checker for the subset of JSON Schema the tool table uses:
 * `type` (string, number, integer, boolean, array, object), `required`, `items`
 * and `minimum`. It is not a JSON Schema implementation and does not try to be —
 * it exists so a host cannot hand handlers values the advertised schema forbids.
 *
 * Returns a message, or null when the arguments conform.
 */
export function checkAgainstSchema(schema: Record<string, unknown>, args: Record<string, unknown>): string | null {
  if (typeof args !== "object" || args === null) return "arguments must be an object";
  const properties = (schema["properties"] ?? {}) as Record<string, Record<string, unknown>>;
  const required = (schema["required"] ?? []) as string[];

  for (const key of required) {
    if (args[key] === undefined) return `missing required parameter: ${key}`;
  }
  for (const [key, value] of Object.entries(args)) {
    const property = properties[key];
    if (property === undefined) return `unknown parameter: ${key}`;
    const problem = checkValue(key, property, value);
    if (problem !== null) return problem;
  }
  return null;
}

function checkValue(key: string, schema: Record<string, unknown>, value: unknown): string | null {
  const type = schema["type"];
  if (type === "string") {
    if (typeof value !== "string") return `${key} must be a string`;
    return null;
  }
  if (type === "number" || type === "integer") {
    if (typeof value !== "number" || Number.isNaN(value)) return `${key} must be a number`;
    if (type === "integer" && !Number.isInteger(value)) return `${key} must be an integer`;
    const minimum = schema["minimum"];
    if (typeof minimum === "number" && value < minimum) return `${key} must be at least ${minimum}`;
    return null;
  }
  if (type === "boolean") {
    if (typeof value !== "boolean") return `${key} must be a boolean`;
    return null;
  }
  if (type === "array") {
    if (!Array.isArray(value)) return `${key} must be an array`;
    const minItems = schema["minItems"];
    if (typeof minItems === "number" && value.length < minItems) return `${key} must have at least ${minItems} items`;
    const items = schema["items"] as Record<string, unknown> | undefined;
    if (items !== undefined) {
      for (const [index, entry] of value.entries()) {
        const problem = checkValue(`${key}[${index}]`, items, entry);
        if (problem !== null) return problem;
      }
    }
    return null;
  }
  return null;
}
