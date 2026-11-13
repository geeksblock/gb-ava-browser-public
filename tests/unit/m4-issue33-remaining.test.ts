/**
 * The three #33 items that were left unfixed, now authorised and closed.
 *
 *   item 1 — `browser_read_page`'s `limit` capped the tree but not the text
 *   item 7 — `page.upload` answered ok for a path that does not exist
 *
 * (item 6, the closed-tab error code, is integration-level: see
 * tests/integration/m3-gaps.spec.ts — a unit fake cannot reproduce a real detach.)
 */

import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { browser_read_page, browser_upload } from "../../adapter/src/tools.js";
import { BridgeError } from "../../adapter/src/errors.js";
import type { ToolContext } from "../../adapter/src/tools.js";

interface Call {
  method: string;
  params: Record<string, unknown>;
}

function recordingContext(reply: (method: string) => unknown = () => ({ ok: true })): {
  context: ToolContext;
  calls: Call[];
} {
  const calls: Call[] = [];
  const client = {
    async call(method: string, params: Record<string, unknown>) {
      calls.push({ method, params });
      return reply(method);
    },
  };
  return { context: { client } as unknown as ToolContext, calls };
}

const readReply = (method: string): unknown =>
  method === "page.getText"
    ? { tabId: 1, text: "hello", truncated: false, documentEpoch: 1 }
    : { tabId: 1, nodes: [], totalNodes: 0, truncated: false, documentEpoch: 1 };

/* ---------------------------------------------------------------- */
/* item 1 — the text cap is its own, controllable thing              */
/* ---------------------------------------------------------------- */

describe("browser_read_page separates the node cap from the text cap (#33 item 1)", () => {
  it("sends page.getText no limit when none was asked for", async () => {
    const { context, calls } = recordingContext(readReply);
    await browser_read_page(context, { tabId: 1 });
    const getText = calls.find((call) => call.method === "page.getText");
    expect(getText!.params).toEqual({ tabId: 1 });
  });

  it("forwards textLimit to page.getText as its limit", async () => {
    const { context, calls } = recordingContext(readReply);
    await browser_read_page(context, { tabId: 1, textLimit: 120_000 });
    const getText = calls.find((call) => call.method === "page.getText");
    expect(getText!.params).toEqual({ tabId: 1, limit: 120_000 });
  });

  it("keeps the two caps separate: limit goes to the tree, textLimit to the text", async () => {
    const { context, calls } = recordingContext(readReply);
    await browser_read_page(context, { tabId: 1, limit: 500, textLimit: 5_000 });
    const readAX = calls.find((call) => call.method === "page.readAX");
    const getText = calls.find((call) => call.method === "page.getText");
    // The bug was that raising the node limit implied nothing about the text.
    expect(readAX!.params).toEqual({ tabId: 1, limit: 500 });
    expect(getText!.params).toEqual({ tabId: 1, limit: 5_000 });
  });

  it("reports the text cap it applied, so truncated is actionable", async () => {
    const { context } = recordingContext(readReply);
    const plain = (await browser_read_page(context, { tabId: 1 })) as { textLimit: number | null };
    expect(plain.textLimit).toBeNull();

    const { context: context2 } = recordingContext(readReply);
    const raised = (await browser_read_page(context2, { tabId: 1, textLimit: 90_000 })) as { textLimit: number | null };
    expect(raised.textLimit).toBe(90_000);
  });
});

/* ---------------------------------------------------------------- */
/* item 7 — a path that does not exist is refused before the bridge  */
/* ---------------------------------------------------------------- */

describe("browser_upload checks the paths before calling the bridge (#33 item 7)", () => {
  const dir = mkdtempSync(join(tmpdir(), "gb-ava-upload-"));
  const realFile = join(dir, "real.txt");
  writeFileSync(realFile, "content\n");

  it("accepts a real file", async () => {
    const { context, calls } = recordingContext();
    await browser_upload(context, { tabId: 1, nodeId: 5, files: [realFile] });
    expect(calls[0]).toEqual({ method: "page.upload", params: { tabId: 1, nodeId: 5, files: [realFile] } });
  });

  it("refuses a path that does not exist, and never reaches the bridge", async () => {
    const { context, calls } = recordingContext();
    const error = await browser_upload(context, {
      tabId: 1,
      nodeId: 5,
      files: [join(dir, "absent.txt")],
    }).catch((e: unknown) => e);

    // This is the whole point: Chrome would have answered ok and attached a
    // zero-byte ghost, so the refusal has to happen here or not at all.
    expect(error).toBeInstanceOf(BridgeError);
    expect((error as BridgeError).code).toBe("invalid_request");
    expect((error as BridgeError).message).toContain("does not exist");
    expect(calls).toHaveLength(0);
  });

  it("refuses a directory rather than handing it to Chrome", async () => {
    const subdir = join(dir, "a-directory");
    mkdirSync(subdir, { recursive: true });
    const { context, calls } = recordingContext();
    const error = await browser_upload(context, { tabId: 1, nodeId: 5, files: [subdir] }).catch((e: unknown) => e);
    expect((error as BridgeError).code).toBe("invalid_request");
    expect((error as BridgeError).message).toContain("is a directory");
    expect(calls).toHaveLength(0);
  });

  it("refuses a relative path with that reason, not as missing", async () => {
    const { context, calls } = recordingContext();
    const error = await browser_upload(context, { tabId: 1, nodeId: 5, files: ["relative.txt"] }).catch((e: unknown) => e);
    expect((error as BridgeError).code).toBe("invalid_request");
    expect((error as BridgeError).message).toContain("not an absolute path");
    expect(calls).toHaveLength(0);
  });

  it("names every bad path in one answer rather than only the first", async () => {
    const { context } = recordingContext();
    const error = await browser_upload(context, {
      tabId: 1,
      nodeId: 5,
      files: [join(dir, "one.txt"), realFile, join(dir, "two.txt")],
    }).catch((e: unknown) => e);
    const message = (error as BridgeError).message;
    expect(message).toContain("one.txt");
    expect(message).toContain("two.txt");
    // The good path is not blamed.
    expect(message).not.toContain("real.txt");
  });

  it("accepts several real files", async () => {
    const second = join(dir, "second.txt");
    writeFileSync(second, "second\n");
    const { context, calls } = recordingContext();
    await browser_upload(context, { tabId: 1, nodeId: 5, files: [realFile, second] });
    expect(calls[0]!.params["files"]).toEqual([realFile, second]);
  });

  it("still surfaces a bridge failure as itself", async () => {
    const { context } = recordingContext(() => {
      throw new BridgeError("not_found", "target could not be resolved to a node", false, {});
    });
    const error = await browser_upload(context, { tabId: 1, nodeId: 5, files: [realFile] }).catch((e: unknown) => e);
    expect((error as BridgeError).code).toBe("not_found");
  });
});

afterEach(() => {
  // nothing global to reset; the temp dirs are disposable
});
