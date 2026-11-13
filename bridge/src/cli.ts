#!/usr/bin/env node
/**
 * gb-ava-bridge — operator entry point.
 *
 *   serve            run the loopback bridge (default command)
 *   health           query the running bridge; exit 1 if the extension is not connected
 *   call <method>    forward one protocol method to the extension, print the JSON reply
 *   token            print the per-install token once, for pasting into the extension
 *
 * The token is printed only by `token`. `serve` logs its fingerprint, never the value.
 */

import { createLogger, type LogRecord } from "@gb-ava/protocol";
import { DEFAULT_PORT, loadConfig } from "./config.js";
import { BIND_HOST, createBridge } from "./server.js";

type Command = "serve" | "health" | "token" | "call";

interface ParsedArgs {
  command: Command;
  port?: number;
  logLevel: string;
  method?: string;
  params?: string;
}

function parseArgs(argv: string[]): ParsedArgs {
  const [first, ...rest] = argv;
  const command: Command = first === undefined || first.startsWith("-") ? "serve" : (first as Command);
  if (!["serve", "health", "token", "call"].includes(command)) {
    throw new Error(`unknown command: ${command} (expected serve, health, call or token)`);
  }
  let port: number | undefined;
  let logLevel = process.env["AVA_BRIDGE_LOG_LEVEL"] ?? "info";
  let method: string | undefined;
  let params: string | undefined;
  const args = first !== undefined && !first.startsWith("-") ? rest : [...argv];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--port") {
      const value = args[i + 1];
      if (value === undefined) throw new Error("--port needs a value");
      const parsed = Number.parseInt(value, 10);
      if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) throw new Error(`invalid port: ${value}`);
      port = parsed;
      i += 1;
    } else if (arg === "--log-level") {
      const value = args[i + 1];
      if (value === undefined) throw new Error("--log-level needs a value");
      logLevel = value;
      i += 1;
    } else if (command === "call" && method === undefined && arg !== undefined && arg.length > 0) {
      method = arg;
    } else if (command === "call" && params === undefined && arg !== undefined && arg.length > 0) {
      params = arg;
    } else if (arg !== undefined && arg.length > 0) {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (command === "call" && method === undefined) {
    throw new Error("call needs a method, e.g. gb-ava-bridge call settings.get");
  }
  const envPort = process.env["AVA_BRIDGE_PORT"];
  if (port === undefined && envPort !== undefined && envPort.length > 0) {
    const parsed = Number.parseInt(envPort, 10);
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) throw new Error(`invalid AVA_BRIDGE_PORT: ${envPort}`);
    port = parsed;
  }
  const parsedArgs: ParsedArgs = { command, logLevel };
  if (port !== undefined) parsedArgs.port = port;
  if (method !== undefined) parsedArgs.method = method;
  if (params !== undefined) parsedArgs.params = params;
  return parsedArgs;
}

function stderrSink(record: LogRecord): void {
  process.stderr.write(`${JSON.stringify(record)}\n`);
}

async function serve(port: number | undefined, logLevel: string): Promise<void> {
  const config = loadConfig();
  const logger = createLogger({
    scope: "gb-ava-bridge",
    sink: stderrSink,
    secrets: [config.token],
    level: logLevel as "debug" | "info" | "warn" | "error",
  });

  const bridge = createBridge({
    port: port ?? config.port ?? DEFAULT_PORT,
    token: config.token,
    allowedExtensionIds: config.allowedExtensionIds,
    logger,
  });

  if (config.tokenCreated) {
    process.stdout.write(
      `gb-ava-bridge: new per-install token created at ${config.tokenPath}\n` +
        `gb-ava-bridge: run "gb-ava-bridge token" to print it and paste it into the extension options page\n`,
    );
  }

  const address = await bridge.start();
  process.stdout.write(
    `${JSON.stringify({ event: "listening", host: address.host, port: address.port })}\n`,
  );

  let stopping = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    logger.info("shutting down", { signal });
    await bridge.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("exit", () => {
    if (!stopping) void bridge.stop();
  });
}

async function health(port: number | undefined): Promise<number> {
  const config = loadConfig();
  const targetPort = port ?? config.port ?? DEFAULT_PORT;
  let response: Response;
  try {
    response = await fetch(`http://${BIND_HOST}:${targetPort}/health`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(5_000),
    });
  } catch (error) {
    process.stderr.write(
      `gb-ava-bridge: cannot reach the bridge on ${BIND_HOST}:${targetPort} (${(error as Error).message})\n`,
    );
    return 2;
  }
  const body: unknown = await response.json();
  process.stdout.write(`${JSON.stringify(body, null, 2)}\n`);
  const connected =
    typeof body === "object" && body !== null && "extension" in body
      ? (body as { extension: { connected?: boolean } }).extension.connected === true
      : false;
  return connected ? 0 : 1;
}

async function call(port: number | undefined, method: string, paramsJson: string | undefined): Promise<number> {
  const config = loadConfig();
  const targetPort = port ?? config.port ?? DEFAULT_PORT;
  let params: unknown;
  if (paramsJson !== undefined) {
    try {
      params = JSON.parse(paramsJson);
    } catch {
      process.stderr.write("gb-ava-bridge: params must be JSON\n");
      return 2;
    }
  }
  const body: Record<string, unknown> = { id: `cli-${Date.now()}`, method };
  if (params !== undefined) body["params"] = params;
  let response: Response;
  try {
    response = await fetch(`http://${BIND_HOST}:${targetPort}/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${config.token}` },
      body: JSON.stringify(body),
      // Long enough for a long-running method (a wait or a download) to answer
      // with its own result instead of the client giving up first.
      signal: AbortSignal.timeout(70_000),
    });
  } catch (error) {
    process.stderr.write(
      `gb-ava-bridge: cannot reach the bridge on ${BIND_HOST}:${targetPort} (${(error as Error).message})\n`,
    );
    return 2;
  }
  const payload: unknown = await response.json();
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  const ok = typeof payload === "object" && payload !== null && (payload as { ok?: boolean }).ok === true;
  return response.ok && ok ? 0 : 1;
}

function token(): number {
  const config = loadConfig();
  process.stdout.write(`${config.token}\n`);
  process.stderr.write(`gb-ava-bridge: token file ${config.tokenPath}\n`);
  return 0;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.command === "token") return token();
  if (args.command === "health") return health(args.port);
  if (args.command === "call") return call(args.port, args.method ?? "", args.params);
  await serve(args.port, args.logLevel);
  return 0;
}

main()
  .then((code) => {
    if (code !== 0) process.exitCode = code;
  })
  .catch((error: unknown) => {
    process.stderr.write(`gb-ava-bridge: ${(error as Error).message}\n`);
    process.exitCode = 1;
  });
