import assert from "node:assert/strict";
import { test } from "node:test";
import { parseRelease, selectUpdate } from "./devpilot-updates.js";

const release = (version: string, prerelease = false) => ({
  tag_name: `v${version}`,
  html_url: `https://github.com/1210350468/devpilot/releases/tag/v${version}`,
  prerelease,
  assets: [
    { name: `DevPilot-windows-x64-v${version}.zip`, browser_download_url: `https://github.com/1210350468/devpilot/releases/download/v${version}/DevPilot-windows-x64-v${version}.zip` },
    { name: `DevPilot-windows-x64-v${version}.zip.sha256`, browser_download_url: `https://github.com/1210350468/devpilot/releases/download/v${version}/DevPilot-windows-x64-v${version}.zip.sha256` },
  ],
});

test("update metadata rejects missing checksums and untrusted asset hosts", () => {
  assert.equal(parseRelease({ ...release("1.2.0"), assets: [] }), undefined);
  const poisoned = release("1.2.0");
  poisoned.assets[0]!.browser_download_url = "https://evil.example/download";
  assert.equal(parseRelease(poisoned), undefined);
  assert.equal(parseRelease({ ...release("1.2.0"), draft: true }), undefined);
});

test("stable updates exclude prerelease, preview updates select highest valid version", () => {
  const releases = [release("1.2.0-beta.2", true), release("1.1.0"), release("1.2.0-beta.3", true)];
  assert.equal(selectUpdate(releases, "1.0.8", "stable").latest?.version, "1.1.0");
  assert.equal(selectUpdate(releases, "1.0.8", "preview").latest?.version, "1.2.0-beta.3");
  assert.equal(selectUpdate(releases, "1.2.0", "preview").available, false);
});
