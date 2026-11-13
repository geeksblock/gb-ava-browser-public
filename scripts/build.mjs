#!/usr/bin/env node
/**
 * Build both packages into `dist/`.
 *
 * - extension/dist is the unpacked extension Chrome loads (and the folder the
 *   Playwright integration test passes to --load-extension).
 * - bridge/dist is the CLI the operator runs.
 *
 * Bundling (esbuild) rather than plain tsc keeps the MV3 service worker free of
 * bare-module imports: Chrome's extension CSP and module resolution are strict,
 * and one self-contained file per entry point is the shape that cannot break at
 * runtime.
 */

import { build } from "esbuild";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const extensionDist = join(root, "extension", "dist");
const bridgeDist = join(root, "bridge", "dist");
const adapterDist = join(root, "adapter", "dist");
const mcpDist = join(root, "mcp", "dist");

const rootPkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const version = String(rootPkg.version ?? "0.0.0");

const shared = {
  bundle: true,
  sourcemap: true,
  legalComments: "none",
  logLevel: "warning",
  define: { "process.env.NODE_ENV": JSON.stringify(process.env.NODE_ENV ?? "production") },
  tsconfig: join(root, "tsconfig.json"),
};

async function buildExtension() {
  rmSync(extensionDist, { recursive: true, force: true });
  mkdirSync(extensionDist, { recursive: true });

  const entries = [
    { in: "extension/src/service-worker.ts", out: "service-worker.js", format: "esm" },
    { in: "extension/src/offscreen.ts", out: "offscreen.js", format: "iife" },
    { in: "extension/src/options.ts", out: "options.js", format: "iife" },
  ];

  for (const entry of entries) {
    await build({
      ...shared,
      entryPoints: [join(root, entry.in)],
      outfile: join(extensionDist, entry.out),
      format: entry.format,
      platform: "browser",
      target: ["chrome116"],
    });
  }

  for (const file of ["offscreen.html", "options.html", "options.css"]) {
    cpSync(join(root, "extension", "src", file), join(extensionDist, file));
  }

  const manifest = JSON.parse(readFileSync(join(root, "extension", "manifest.json"), "utf8"));
  manifest.version = version;
  writeFileSync(join(extensionDist, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

  const icons = join(root, "extension", "src", "icons");
  try {
    cpSync(icons, join(extensionDist, "icons"), { recursive: true });
  } catch {
    throw new Error("extension icons are missing — run `npm run icons` first");
  }
  process.stdout.write(`extension  -> ${extensionDist}\n`);
}

async function buildBridge() {
  rmSync(bridgeDist, { recursive: true, force: true });
  mkdirSync(bridgeDist, { recursive: true });
  await build({
    ...shared,
    entryPoints: [join(root, "bridge", "src", "cli.ts")],
    outfile: join(bridgeDist, "cli.js"),
    format: "esm",
    platform: "node",
    target: ["node22"],
    // The shebang comes from the entry file itself; esbuild preserves it. Adding a
    // banner as well produced a second shebang on line 2 and a SyntaxError.
    external: ["ws"],
  });
  process.stdout.write(`bridge     -> ${bridgeDist}\n`);
}

async function buildAdapter() {
  rmSync(adapterDist, { recursive: true, force: true });
  mkdirSync(adapterDist, { recursive: true });
  await build({
    ...shared,
    entryPoints: [join(root, "adapter", "src", "index.ts")],
    outfile: join(adapterDist, "index.js"),
    format: "esm",
    platform: "node",
    target: ["node22"],
  });
  // Declarations for the workspace consumer: esbuild bundles the JS but does not
  // emit types, and the package.json points at them.
  const { execFileSync } = await import("node:child_process");
  execFileSync(process.execPath, [
    join(root, "node_modules", "typescript", "bin", "tsc"),
    "-p",
    join(root, "tsconfig.adapter.json"),
  ]);
  process.stdout.write(`adapter    -> ${adapterDist}\n`);
}

async function buildMcp() {
  rmSync(mcpDist, { recursive: true, force: true });
  mkdirSync(mcpDist, { recursive: true });
  await build({
    ...shared,
    entryPoints: [join(root, "mcp", "src", "index.ts")],
    outfile: join(mcpDist, "index.js"),
    format: "esm",
    platform: "node",
    target: ["node22"],
    // The shebang is in the entry file; esbuild preserves it.
    banner: { js: "" },
  });
  process.stdout.write(`mcp        -> ${mcpDist}\n`);
}

await buildExtension();
await buildBridge();
await buildAdapter();
await buildMcp();
