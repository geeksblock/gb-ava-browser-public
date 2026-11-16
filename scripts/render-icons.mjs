#!/usr/bin/env node
/**
 * Render the manifest icons from one locally bundled Phosphor icon.
 *
 * AGENTS.md: one Phosphor family, rendered to PNG for the manifest sizes; no
 * hand-drawn SVG paths, no emoji. The SVG master stays in the repo under
 * extension/src/icons/source/ so a future size or weight change re-renders from
 * the same file rather than from a drawing.
 */

import { chromium } from "playwright";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const iconsDir = join(root, "extension", "src", "icons");
const sourceDir = join(iconsDir, "source");
const SIZES = [16, 32, 48, 128];
const BRAND = "#0066FF";

/** Candidate Phosphor assets, first match wins. */
const CANDIDATES = ["browser", "globe", "globe-hemisphere-west", "compass"];

function findPhosphorSvg() {
  const base = join(root, "node_modules", "@phosphor-icons", "core", "assets", "regular");
  for (const name of CANDIDATES) {
    const candidate = join(base, `${name}.svg`);
    if (existsSync(candidate)) return { name, path: candidate };
  }
  throw new Error(`no Phosphor icon found in ${base} (tried ${CANDIDATES.join(", ")}) — is @phosphor-icons/core installed?`);
}

function sizedSvg(svg, size) {
  // Phosphor assets are 256x256 with no width/height; set both explicitly and
  // colour the mark with the brand token.
  return svg
    .replace(/<svg([^>]*)>/, (_match, attrs) => {
      const cleaned = attrs
        .replace(/\swidth="[^"]*"/, "")
        .replace(/\sheight="[^"]*"/, "")
        .replace(/\sfill="[^"]*"/, "");
      return `<svg${cleaned} width="${size}" height="${size}" fill="${BRAND}">`;
    })
    .replace(/currentColor/g, BRAND);
}

const { name, path: svgPath } = findPhosphorSvg();
const raw = readFileSync(svgPath, "utf8");
mkdirSync(sourceDir, { recursive: true });
copyFileSync(svgPath, join(sourceDir, `ava-browser-${name}.svg`));

const browser = await chromium.launch();
try {
  for (const size of SIZES) {
    const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
    await page.setContent(
      `<!doctype html><html><body style="margin:0;background:transparent;width:${size}px;height:${size}px;display:flex;align-items:center;justify-content:center">${sizedSvg(raw, size)}</body></html>`,
    );
    const svg = page.locator("svg");
    await svg.screenshot({ path: join(iconsDir, `icon-${size}.png`), omitBackground: true });
    await page.close();
  }
  writeFileSync(
    join(iconsDir, "README.md"),
    [
      "# Icons",
      "",
      `Rendered from the Phosphor \`${name}\` (regular weight) master in \`source/\` by \`npm run icons\`.`,
      "",
      "Do not hand-edit the PNGs. Change the master, or the sizes/colour in `scripts/render-icons.mjs`, and re-render.",
      "Colour: Trust Blue `#0066FF` (Geeksblock brand token).",
      "",
      "Icon source: Phosphor Icons (`@phosphor-icons/core`), MIT licence — one family, bundled locally, per AGENTS.md.",
      "",
    ].join("\n"),
  );
} finally {
  await browser.close();
}

process.stdout.write(`icons rendered from phosphor/${name}: ${SIZES.join(", ")}px\n`);
