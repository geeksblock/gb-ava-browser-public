/**
 * Bridge configuration and the per-install bearer token.
 *
 * Location: the per-user config directory, never the repo.
 *   macOS/Linux: $XDG_CONFIG_HOME/gb-ava-bridge or ~/.config/gb-ava-bridge
 *   override:    AVA_BRIDGE_CONFIG_DIR (used by the test suite)
 *
 * Both files are created 0600 inside a 0700 directory. The token is generated
 * once; re-running the bridge reuses it so the copy pasted into the extension
 * keeps working.
 */

import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface BridgeConfigFile {
  /** Extension ids allowed to connect. Empty = any `chrome-extension://` origin. */
  allowedExtensionIds: string[];
  port?: number;
}

export interface BridgeConfig {
  directory: string;
  tokenPath: string;
  configPath: string;
  token: string;
  tokenCreated: boolean;
  allowedExtensionIds: string[];
  port?: number;
}

export const DEFAULT_PORT = 8765;
export const TOKEN_BYTES = 32;

export function configDirectory(env: NodeJS.ProcessEnv = process.env): string {
  const override = env["AVA_BRIDGE_CONFIG_DIR"];
  if (override && override.trim().length > 0) return override;
  const xdg = env["XDG_CONFIG_HOME"];
  const base = xdg && xdg.trim().length > 0 ? xdg : join(homedir(), ".config");
  return join(base, "gb-ava-bridge");
}

export function generateToken(): string {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

function ensurePrivateDirectory(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {
    // Best effort: an existing directory owned by someone else is reported by the file write below.
  }
}

function writePrivateFile(path: string, contents: string): void {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, contents, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

/** Generate the token on first run, reuse it afterwards. */
export function ensureToken(directory: string): { token: string; created: boolean } {
  ensurePrivateDirectory(directory);
  const tokenPath = join(directory, "token");
  if (existsSync(tokenPath)) {
    const existing = readFileSync(tokenPath, "utf8").trim();
    if (existing.length >= 32) {
      // Re-assert the mode: a token restored by cp or Time Machine keeps the
      // permissions it arrived with, and 0644 would make it world-readable.
      try {
        chmodSync(tokenPath, 0o600);
      } catch {
        // Best effort; the file still works if the mode could not be changed.
      }
      return { token: existing, created: false };
    }
    // Too short to be one of ours: replace rather than trust it.
    const token = generateToken();
    writePrivateFile(tokenPath, `${token}\n`);
    return { token, created: true };
  }
  const token = generateToken();
  writePrivateFile(tokenPath, `${token}\n`);
  return { token, created: true };
}

export function readConfigFile(directory: string): BridgeConfigFile {
  const configPath = join(directory, "config.json");
  if (!existsSync(configPath)) {
    ensurePrivateDirectory(directory);
    writePrivateFile(configPath, `${JSON.stringify({ allowedExtensionIds: [] }, null, 2)}\n`);
    return { allowedExtensionIds: [] };
  }
  const raw = readFileSync(configPath, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`config is not valid JSON: ${configPath}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`config must be a JSON object: ${configPath}`);
  }
  const record = parsed as Record<string, unknown>;
  const ids = record["allowedExtensionIds"];
  if (ids !== undefined && (!Array.isArray(ids) || ids.some((id) => typeof id !== "string"))) {
    throw new Error(`allowedExtensionIds must be an array of strings: ${configPath}`);
  }
  const port = record["port"];
  if (port !== undefined && (typeof port !== "number" || !Number.isInteger(port) || port < 0 || port > 65535)) {
    throw new Error(`port must be an integer 0-65535: ${configPath}`);
  }
  const config: BridgeConfigFile = { allowedExtensionIds: (ids as string[] | undefined) ?? [] };
  if (port !== undefined) config.port = port as number;
  return config;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): BridgeConfig {
  const directory = configDirectory(env);
  const { token, created } = ensureToken(directory);
  const config = readConfigFile(directory);
  const loaded: BridgeConfig = {
    directory,
    tokenPath: join(directory, "token"),
    configPath: join(directory, "config.json"),
    token,
    tokenCreated: created,
    allowedExtensionIds: config.allowedExtensionIds,
  };
  if (config.port !== undefined) loaded.port = config.port;
  return loaded;
}
