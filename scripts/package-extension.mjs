#!/usr/bin/env node
/**
 * Package the built extension for installation.
 *
 * Produces `dist-package/gb-ava-extension-<version>.zip` (what a person or an
 * enterprise policy can install) and prints its SHA-256, which is what a password manager
 * record or a change ticket should carry.
 *
 * The zip is built from `extension/dist` only — never from `extension/src` — so
 * the package is exactly what the build produced and what the tests loaded.
 */

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "extension", "dist");
const outDir = join(root, "dist-package");
const manifestPath = join(dist, "manifest.json");

if (!existsSync(manifestPath)) {
  process.stderr.write("extension/dist is missing — run `npm run build` first\n");
  process.exit(1);
}

const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const version = String(manifest.version ?? "0.0.0");
const target = join(outDir, `gb-ava-extension-${version}.zip`);

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

// `zip` is present on macOS and on the GitHub runners; a Node zip library would be
// another dependency for one call.
execFileSync("zip", ["-qr", target, "."], { cwd: dist });

const bytes = readFileSync(target);
const sha256 = createHash("sha256").update(bytes).digest("hex");
process.stdout.write(
  `${JSON.stringify({
    event: "packaged",
    file: target,
    version,
    bytes: statSync(target).size,
    sha256,
    manifestVersion: manifest.manifest_version,
    minChrome: manifest.minimum_chrome_version ?? null,
  })}\n`,
);
