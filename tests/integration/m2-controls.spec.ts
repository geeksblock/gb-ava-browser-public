import { expect, test } from "@playwright/test";
import {
  bridgeCall,
  configureViaOptionsPage,
  launchExtension,
  startBridge,
  startFixtureSite,
  waitForConnected,
  type BridgeHandle,
  type ExtensionHandle,
  type FixtureSite,
} from "./helpers.js";

/**
 * #24 and #25, both found on a real support portal.
 *
 * #24 — `page.select` with a bare selector like `"select"` takes the FIRST match on
 * the page, which may be an unrelated control. The fix reports what was matched so a
 * wrong first choice is visible in the result, instead of only inferable from an
 * option list.
 *
 * #25 — `page.readAX` reported no checked state for checkboxes, so verifying a tick
 * needed `page.evaluate`. The tree now carries a tri-state `checked`.
 */

let bridge: BridgeHandle;
let extension: ExtensionHandle;
let site: FixtureSite;

test.beforeEach(async () => {
  bridge = await startBridge();
  site = await startFixtureSite();
  extension = await launchExtension();
  const page = await extension.optionsPage();
  await configureViaOptionsPage(page, bridge.port, bridge.token);
  await waitForConnected(bridge.port);
});

test.afterEach(async () => {
  await extension?.close();
  await bridge?.stop();
  await site?.close();
});

interface AxNode {
  nodeId: number | null;
  role: string;
  name: string;
  value: string | null;
  checked: boolean | null;
  disabled: boolean;
}

interface ReadReply {
  ok: boolean;
  result?: { nodes: AxNode[]; documentEpoch: number };
  error?: { code: string; message: string };
}

async function openTab(path: string): Promise<number> {
  const reply = (await bridgeCall(bridge.port, bridge.token, "tabs.create", {
    url: site.url(path),
  })) as unknown as { ok: boolean; result?: { tabId: number } };
  expect(reply.ok).toBe(true);
  return reply.result!.tabId;
}

async function readTree(tabId: number): Promise<AxNode[]> {
  const reply = (await bridgeCall(bridge.port, bridge.token, "page.readAX", {
    tabId,
    limit: 4000,
  })) as unknown as ReadReply;
  expect(reply.ok, JSON.stringify(reply.error)).toBe(true);
  return reply.result?.nodes ?? [];
}

function checkbox(nodes: AxNode[], name: string): AxNode | undefined {
  return nodes.find((node) => node.role === "checkbox" && node.name.includes(name));
}

test("#25: page.readAX reports a checkbox's checked state", async () => {
  const tabId = await openTab("/controls");
  const nodes = await readTree(tabId);

  // The fixture ships one box pre-checked, so the tree must distinguish the two —
  // which is exactly what the bug report said it could not do.
  const all = checkbox(nodes, "All tickets");
  const fresh = checkbox(nodes, "New tickets");
  expect(all, "All tickets checkbox must be in the tree").toBeDefined();
  expect(fresh, "New tickets checkbox must be in the tree").toBeDefined();

  expect(all!.checked).toBe(false);
  expect(fresh!.checked).toBe(true);
});

test("#25: a ticked box is visible in the tree, without page.evaluate", async () => {
  const tabId = await openTab("/controls");
  const before = await readTree(tabId);
  const target = checkbox(before, "All tickets");
  expect(target!.checked).toBe(false);

  const clicked = (await bridgeCall(bridge.port, bridge.token, "page.click", {
    tabId,
    nodeId: target!.nodeId,
  })) as unknown as { ok: boolean; error?: { code: string; message: string } };
  expect(clicked.ok, JSON.stringify(clicked.error)).toBe(true);

  const after = await readTree(tabId);
  const ticked = checkbox(after, "All tickets");
  // The whole point of #25: the state change is readable from the tree alone.
  expect(ticked!.checked).toBe(true);
});

test("#25: a non-checkable node reports checked as null, not false", async () => {
  const tabId = await openTab("/controls");
  const nodes = await readTree(tabId);

  const heading = nodes.find((node) => node.role === "heading");
  expect(heading, "the fixture has a heading").toBeDefined();
  // Tri-state: null means "cannot be checked", which is different from "unchecked".
  expect(heading!.checked).toBeNull();

  const combobox = nodes.find((node) => node.role === "combobox" && node.name.includes("Theme"));
  if (combobox) expect(combobox.checked).toBeNull();
});

test("#24: an ambiguous selector is refused, with candidates the agent can act on", async () => {
  const tabId = await openTab("/controls");

  // A bare `select` matches BOTH dropdowns. Rather than take the first (the theme
  // picker, which is what went wrong on the support portal), it refuses and says
  // what collided — so the agent learns exactly how to fix its selector.
  const reply = (await bridgeCall(bridge.port, bridge.token, "page.select", {
    tabId,
    selector: "select",
    value: "trust-blue",
  })) as unknown as {
    ok: boolean;
    error?: {
      code: string;
      message: string;
      detail?: {
        matchCount?: number;
        matches?: Array<{ tag: string; id: string | null; name: string | null; text: string | null; visible: boolean }>;
      };
    };
  };

  expect(reply.ok, "an ambiguous selector must not act").toBe(false);
  expect(reply.error?.code).toBe("invalid_request");

  // The message names the count, so the agent knows it is a collision, not a typo.
  expect(reply.error?.message).toContain("matches 2 elements");

  // And the detail carries each candidate: what it is, and the selector to use.
  const matches = reply.error?.detail?.matches ?? [];
  expect(matches).toHaveLength(2);
  expect(reply.error?.detail?.matchCount).toBe(2);
  expect(matches[0]!.tag).toBe("select");
  expect(matches[0]!.id).toBe("theme");
  expect(matches[1]!.name).toBe("contact");
  // Every candidate is visible, so the agent is not being sent to a hidden duplicate.
  expect(matches.every((m) => m.visible)).toBe(true);
});

test("#24: a unique selector with an explicit id is still accepted", async () => {
  const tabId = await openTab("/controls");
  const reply = (await bridgeCall(bridge.port, bridge.token, "page.select", {
    tabId,
    selector: "select#theme",
    value: "aurora",
  })) as unknown as { ok: boolean; result?: { value: string }; error?: { code: string; message: string } };
  expect(reply.ok, JSON.stringify(reply.error)).toBe(true);
  expect(reply.result?.value).toBe("aurora");
});

test("#24: a successful select reports which control it matched", async () => {
  const tabId = await openTab("/controls");

  // A specific selector, so this is the success path. The reply still says what it
  // touched, so an agent can log or assert on the control rather than trusting it.
  const reply = (await bridgeCall(bridge.port, bridge.token, "page.select", {
    tabId,
    selector: "select#theme",
    value: "trust-blue",
  })) as unknown as {
    ok: boolean;
    result?: { value: string; matched?: { tag: string; id: string | null; name: string | null; options: number } };
    error?: { code: string; message: string };
  };

  expect(reply.ok, JSON.stringify(reply.error)).toBe(true);
  expect(reply.result?.matched, "the matched control must be reported").toBeDefined();
  expect(reply.result!.matched!.tag).toBe("select");
  expect(reply.result!.matched!.id).toBe("theme");
  expect(reply.result!.matched!.options).toBe(2);
});

test("#24: a failed select names the control it matched and why", async () => {
  const tabId = await openTab("/controls");

  // A specific control, but a value that is not one of its options: the error names
  // the control AND lists what it does offer, so the agent can correct itself.
  const reply = (await bridgeCall(bridge.port, bridge.token, "page.select", {
    tabId,
    selector: "select#theme",
    value: "contact-b",
  })) as unknown as {
    ok: boolean;
    error?: { code: string; message: string; detail?: { options?: string[]; matched?: { id: string | null } } };
  };

  expect(reply.ok).toBe(false);
  expect(reply.error?.code).toBe("invalid_request");
  expect(reply.error?.detail?.matched?.id).toBe("theme");
  expect(reply.error?.detail?.options).toEqual(["trust-blue", "aurora"]);
});

test("#24: selecting by an explicit id reaches the intended control", async () => {
  const tabId = await openTab("/controls");

  const reply = (await bridgeCall(bridge.port, bridge.token, "page.select", {
    tabId,
    selector: "select[name=contact]",
    value: "b",
  })) as unknown as {
    ok: boolean;
    result?: { value: string; matched?: { name: string | null } };
    error?: { code: string; message: string };
  };

  expect(reply.ok, JSON.stringify(reply.error)).toBe(true);
  expect(reply.result?.value).toBe("b");
  expect(reply.result?.matched?.name).toBe("contact");
});
