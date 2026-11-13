# Installing the extension on a managed Chrome (enterprise)

Two ways in, and both are supported by the same package:

## 1. A person installs the unpacked build (development, pilots)

1. `npm ci && npm run build` in the repo.
2. Chrome → `chrome://extensions` → enable **Developer mode** → **Load unpacked** →
   `extension/dist`.
3. Pair it: run the bridge once (`node bridge/dist/cli.js serve`), then paste the token
   (`node bridge/dist/cli.js token`) into the extension's options page.

Edge and Brave use the same Chromium extension APIs (`chrome.*`), so the same folder loads at
`edge://extensions` and `brave://extensions`. They are **documented as supported, not yet verified in
this repo's CI** — the automated suite runs Chromium. Verify both before a release that ships to a
client estate.

## 2. Force-install through policy (a managed fleet)

`npm run package` produces `dist-package/gb-ava-extension-<version>.zip` and prints its SHA-256. That
zip is the unsigned package; a policy install needs a signed `.crx` and an update manifest:

1. Sign the zip with the organisation's extension key (`chrome --pack-extension=extension/dist
   --pack-extension-key=gb-ava.pem`, or `crx3` in CI). Keep the key out of the repo; the extension id
   is derived from it and never changes.
2. Host the `.crx` and a `updates.xml` (template in `packaging/updates.xml`) over HTTPS.
3. Apply the policy: `packaging/extension-settings.json` for the `ExtensionSettings` policy (preferred:
   it also pins the toolbar button) or `ExtensionInstallForcelist` for the older form. Fill in the
   extension id and the update URL.
4. On the managed device: `chrome://policy` → reload policies, then confirm the extension is listed as
   **Installed by your administrator** and that it is *not* removable.

**What is verified here and what is not.** The package builds, the SHA-256 is printed, and the policy
files are in place. The policy *application* on a real managed device is the one step this repo cannot
test — it needs a machine enrolled in the organisation's Chrome management. Until someone has done it,
treat "force-install works" as unproven.

## What the extension needs from the machine

- A reachable loopback bridge on `127.0.0.1:8765` (the bridge is a per-user process; it is not
  installed by the extension).
- The token from `~/.config/gb-ava-bridge/token`, pasted once into the options page.
- No network egress: the extension talks to the bridge and nothing else.

## Permissions a reviewer will ask about

`tabs`, `tabGroups`, `scripting`, `debugger`, `storage`, `alarms`, `offscreen`, `downloads`, and
`<all_urls>`. Each is justified in `IMPLEMENTATION-PLAN.md` §3; `cookies`, `webRequest`, `identity`,
`notifications` and `unlimitedStorage` are deliberately not requested.
