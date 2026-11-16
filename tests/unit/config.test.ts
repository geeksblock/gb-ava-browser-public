import { describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertSafeUploadDirectory, configDirectory, ensureToken, expandUploadDirectory, generateToken, loadConfig, readConfigFile } from "../../bridge/src/config.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "gb-ava-bridge-test-"));
}

describe("token store", () => {
  it("generates a 256-bit token", () => {
    const token = generateToken();
    expect(token.length).toBeGreaterThanOrEqual(42);
    expect(generateToken()).not.toBe(token);
  });

  it("creates the token once with 0600 permissions and reuses it afterwards", () => {
    const dir = tempDir();
    const first = ensureToken(dir);
    expect(first.created).toBe(true);
    const mode = statSync(join(dir, "token")).mode & 0o777;
    expect(mode).toBe(0o600);

    const second = ensureToken(dir);
    expect(second.created).toBe(false);
    expect(second.token).toBe(first.token);
  });

  it("re-asserts 0600 on an existing token that arrived with looser permissions", () => {
    const dir = tempDir();
    const { token } = ensureToken(dir);
    const path = join(dir, "token");
    // A token restored by cp or Time Machine keeps whatever mode it had.
    writeFileSync(path, `${token}\n`);
    chmodSync(path, 0o644);
    expect(statSync(path).mode & 0o777).toBe(0o644);
    const reused = ensureToken(dir);
    expect(reused.token).toBe(token);
    expect(reused.created).toBe(false);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("replaces an implausibly short token rather than trusting it", () => {
    const dir = tempDir();
    const { token } = ensureToken(dir);
    // Simulate a truncated file.
    const shortDir = tempDir();
    writeFileSync(join(shortDir, "token"), "abc\n");
    const replaced = ensureToken(shortDir);
    expect(replaced.created).toBe(true);
    expect(replaced.token).not.toBe("abc");
    expect(replaced.token).not.toBe(token);
  });

  it("defaults the config file to an empty extension allowlist", () => {
    const dir = tempDir();
    expect(readConfigFile(dir)).toEqual({ allowedExtensionIds: [] });
    const raw = JSON.parse(readFileSync(join(dir, "config.json"), "utf8"));
    expect(raw).toEqual({ allowedExtensionIds: [] });
  });

  it("rejects a config file that is not an object, instead of guessing", () => {
    const dir = tempDir();
    readConfigFile(dir);
    writeFileSync(join(dir, "config.json"), "[]");
    expect(() => readConfigFile(dir)).toThrow(/JSON object/);
  });

  it("rejects a non-string extension id", () => {
    const dir = tempDir();
    readConfigFile(dir);
    writeFileSync(join(dir, "config.json"), JSON.stringify({ allowedExtensionIds: [1] }));
    expect(() => readConfigFile(dir)).toThrow(/array of strings/);
  });
});

describe("config directory", () => {
  it("honours AVA_BRIDGE_CONFIG_DIR so tests and operators can isolate state", () => {
    expect(configDirectory({ AVA_BRIDGE_CONFIG_DIR: "/tmp/x" } as NodeJS.ProcessEnv)).toBe("/tmp/x");
  });

  it("falls back to XDG_CONFIG_HOME then the home directory", () => {
    expect(configDirectory({ XDG_CONFIG_HOME: "/tmp/cfg" } as NodeJS.ProcessEnv)).toBe(join("/tmp/cfg", "gb-ava-bridge"));
    expect(configDirectory({ HOME: "/Users/nobody" } as NodeJS.ProcessEnv)).toMatch(/gb-ava-bridge$/);
  });

  it("loads a complete config and marks whether the token was just created", () => {
    const dir = tempDir();
    const loaded = loadConfig({ AVA_BRIDGE_CONFIG_DIR: dir, AVA_BRIDGE_UPLOAD_DIR: join(dir, "uploads") } as NodeJS.ProcessEnv);
    expect(loaded.tokenCreated).toBe(true);
    expect(loaded.token.length).toBeGreaterThan(30);
    expect(loaded.allowedExtensionIds).toEqual([]);
    const again = loadConfig({ AVA_BRIDGE_CONFIG_DIR: dir, AVA_BRIDGE_UPLOAD_DIR: join(dir, "uploads") } as NodeJS.ProcessEnv);
    expect(again.token).toBe(loaded.token);
    expect(again.tokenCreated).toBe(false);
  });
});

describe("the upload folder is a dedicated folder (ADR 0005)", () => {
  it("refuses /, the home folder and any folder that contains the bridge config", () => {
    const home = "/Users/someone";
    const config = "/Users/someone/.config/gb-ava-bridge";
    for (const bad of ["/", home, "/Users/someone/.config", config]) {
      expect(() => assertSafeUploadDirectory(bad, config, home), bad).toThrow(/dedicated folder/);
    }
    expect(() => assertSafeUploadDirectory("/Users/someone/Ava Uploads", config, home)).not.toThrow();
  });

  it("expands ~/ and refuses a relative path", () => {
    expect(expandUploadDirectory("~/Ava Uploads", "/Users/someone")).toBe("/Users/someone/Ava Uploads");
    expect(() => expandUploadDirectory("uploads", "/Users/someone")).toThrow(/absolute/);
  });
});
