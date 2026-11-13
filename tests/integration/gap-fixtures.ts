import { createServer, type Server } from "node:http";

/**
 * A second fixture origin for the end-to-end gap suite.
 *
 * `helpers.startFixtureSite` is shared by every spec, and editing it would move
 * the behaviour other tests are pinned to. This one adds the pages those suites
 * do not have: a real HTML validation form, a horizontally scrollable pane, a
 * native `<select>` with a `change` listener that records itself, and a page
 * whose navigation can be held open so two commands really overlap.
 *
 * `onRequest` lets a test react to a request (e.g. navigate the tab away while
 * the request is still hanging), so timing is event-driven rather than a sleep.
 */
export type RequestHook = (path: string) => void;

export interface GapSite {
  origin: string;
  url(path: string): string;
  /** Called for every request, in arrival order. */
  onRequest(hook: RequestHook): void;
  close(): Promise<void>;
}

const PAGES: Record<string, string> = {
  "/form-validation": `<!doctype html><meta charset=utf-8><title>fixture-validation</title>
<h1>New request</h1>
<form id=requestForm method=get action="/submitted">
  <label for=name>Name</label><input id=name name=name required>
  <label for=email>Email</label><input id=email name=email type=email required>
  <label for=quantity>Quantity</label><input id=quantity name=quantity type=number min=1 max=5 required>
  <label><input id=agree name=agree type=checkbox required> I agree</label>
  <button id=submitForm type=submit>Submit</button>
  <output id=validity></output>
</form>
<script>
  document.getElementById('requestForm').addEventListener('invalid', (event) => {
    document.getElementById('validity').textContent = 'INVALID:' + (event.target.id || event.target.name);
  }, true);
</script>`,
  "/submitted": "<title>fixture-submitted</title><h1 id=heading>Submitted</h1><p id=summary>thanks</p>",
  // The same /form markup helpers.startFixtureSite serves, so a test can upload a
  // second file (a file input accepts one pick per change) or select on a page
  // this origin owns.
  "/form": `<!doctype html><meta charset=utf-8><title>fixture-form</title>
<h1>Form</h1>
<select id=colour><option value=red>Red</option><option value=green>Green</option></select>
<input id=file type=file>
<input id=fileMulti type=file multiple>
<input id=hiddenFile type=file style="display:none">
<button id=save type=button>Save</button>
<p id=count>idle</p>
<script>
  document.getElementById('file').addEventListener('change', (e) => {
    document.getElementById('count').textContent = 'file:' + Array.from(e.target.files).map((f) => f.name).join(',');
  });
</script>`,
  // Pages the suite opens on this origin. They are served here, not taken from
  // helpers' site, which is shared with the other specs.
  "/login": "<title>fixture-login</title><input id=email><input id=password type=password><button id=submit>Sign in</button>",
  "/alpha": "<title>fixture-alpha</title><h1 id=heading>alpha</h1>",
  "/beta": "<title>fixture-beta</title><h1 id=heading>beta</h1>",
  "/scroller": `<!doctype html><meta charset=utf-8><title>fixture-scroller</title>
<h1 id=heading>scroller</h1>
<div id=inner style="height:120px;overflow:auto;border:1px solid #000"><div style="height:2000px">inner content</div></div>
<div id=tall style="height:4000px">below the fold</div>`,
  "/wide": `<!doctype html><meta charset=utf-8><title>fixture-wide</title>
<h1 id=heading>wide</h1>
<div id=pane style="width:300px;height:200px;overflow:auto;border:1px solid #000">
  <div id=wide-inner style="width:4000px;height:100px">wide content</div>
</div>
<div id=tall style="height:4000px">tall</div>`,
  // Counters live in closures on purpose: `page.evaluate` runs in the page's own
  // world, which is a different world from the extension's isolated content-script
  // one, so a `window.__x` set by one is invisible to the other.
  "/select": `<!doctype html><meta charset=utf-8><title>fixture-select</title>
<h1 id=heading>select</h1>
<select id=colour>
  <option value=red>Red</option>
  <option value=green>Green</option>
  <option value=blue disabled>Blue</option>
</select>
<select id=multi multiple><option value=a>A</option><option value=b>B</option></select>
<input id=choice name=choice>
<input id=colour-value name=colour-value>
<input id=counts name=counts value=change:0,input:0>
<p id=events></p>
<script>
  const counters = { change: 0, input: 0 };
  const paint = () => { document.getElementById('counts').value = 'change:' + counters.change + ',input:' + counters.input; };
  document.getElementById('colour').addEventListener('change', (event) => {
    counters.change += 1;
    // A framework-style observer of the input/change pair.
    document.getElementById('choice').value = event.target.value;
    document.getElementById('events').textContent = 'change:' + counters.change;
    paint();
  });
  document.getElementById('colour').addEventListener('input', () => { counters.input += 1; paint(); });
  const sync = () => { document.getElementById('colour-value').value = document.getElementById('colour').value; };
  document.getElementById('colour').addEventListener('input', sync);
  document.getElementById('colour').addEventListener('change', sync);
</script>`,
  // A navigation that never finishes loading its document body: the request is
  // held open, so the tab stays in `loading` until the test ends the response.
  "/hang": "<title>fixture-hang</title><h1 id=heading>hang</h1>",
  "/slow": "<title>fixture-slow</title><h1 id=heading>slow</h1>",
  // One page the click and type gap tests drive on an unrelated tab; the
  // navigation test moves its own tab, and a tab must never be driven twice.
  "/clicktest": `<!doctype html><meta charset=utf-8><title>fixture-clicktest</title>
<h1 id=heading>clicktest</h1>
<button id=hit type=button onclick="document.getElementById('result').textContent='clicked'">Hit</button>
<button id=alertButton type=button onclick="alert('are you sure')">Delete</button>
<div id=result>idle</div>`,
};

export async function startGapSite(): Promise<GapSite> {
  const hooks: RequestHook[] = [];
  const held: Array<{ response: import("node:http").ServerResponse; release: () => void }> = [];
  const server: Server = createServer((request, response) => {
    const path = (request.url ?? "/").split("?")[0] ?? "/";
    for (const hook of hooks) hook(path);

    if (path === "/hang") {
      // Keep the response open: the document never reaches `complete` while it is
      // pending, which is exactly a navigation that is "mid-flight".
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      response.write("<!doctype html><meta charset=utf-8><title>fixture-hang</title>");
      held.push({ response, release: () => response.end("<h1 id=heading>released</h1>") });
      return;
    }
    if (path === "/slow") {
      setTimeout(() => {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        response.end("<!doctype html><meta charset=utf-8>" + PAGES["/slow"]);
      }, 400);
      return;
    }
    const body = PAGES[path];
    if (body === undefined) {
      response.writeHead(404, { "content-type": "text/plain" });
      response.end("not found");
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    // Every page is served as `<!doctype html><meta charset=utf-8>` plus its own
    // head and body; the fixture pages above already carry a <title>.
    response.end(`<!doctype html><meta charset=utf-8>${body}`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("gap fixture site failed to bind");
  const origin = `http://127.0.0.1:${address.port}`;
  return {
    origin,
    url: (path: string) => `${origin}${path}`,
    onRequest: (hook) => {
      hooks.push(hook);
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const entry of held) entry.release();
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
