import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  discoverAsterBridgeRoxySettings,
  parseDevToolsActivePort,
  sameConversationUrl,
} from "./goal-browser-roxy.js";

test("AsterBridge Roxy settings discovery reads only enabled non-secret launcher state", async (t) => {
  const root = join(tmpdir(), `devspace-roxy-settings-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const userData = join(root, "AsterBridge");
  const dataDir = join(root, "roxy-data");
  await mkdir(userData, { recursive: true });
  await mkdir(dataDir, { recursive: true });
  const statePath = join(userData, "launcher-state.json");
  await writeFile(statePath, JSON.stringify({
    version: 1,
    useRoxyBrowser: true,
    roxyBrowserProfileId: "profile_12345678",
    roxyBrowserDataDir: dataDir,
    roxyBrowserAutoOpen: true,
    roxyBrowserApiHost: "http://127.0.0.1:50000",
  }));
  t.after(() => rm(root, { recursive: true, force: true }));

  const settings = discoverAsterBridgeRoxySettings({
    ASTERBRIDGE_LAUNCHER_STATE: statePath,
  });
  assert.equal(settings.profileId, "profile_12345678");
  assert.equal(settings.dataDir, dataDir);
  assert.equal(settings.autoOpen, true);
  assert.equal(settings.apiHost, "http://127.0.0.1:50000");
  assert.equal(settings.userDataDir, userData);
  assert.equal(settings.sourcePath, statePath);
});

test("AsterBridge Roxy settings discovery falls back to the current core config", async (t) => {
  const root = join(tmpdir(), `devspace-roxy-core-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const coreHome = join(root, "core");
  const dataDir = join(root, "roxy-data");
  const apiKeyFile = join(root, "secrets", "roxy-browser-api.key");
  await mkdir(coreHome, { recursive: true });
  await mkdir(dataDir, { recursive: true });
  const configPath = join(coreHome, "config.json");
  await writeFile(configPath, JSON.stringify({
    turnBrowserHost: "roxybrowser",
    roxyBrowserProfileId: "profile_87654321",
    roxyBrowserDataDir: dataDir,
    roxyBrowserAutoOpen: true,
    roxyBrowserApiHost: "http://127.0.0.1:50000",
    roxyBrowserApiKeyFile: apiKeyFile,
  }));
  t.after(() => rm(root, { recursive: true, force: true }));

  const settings = discoverAsterBridgeRoxySettings({
    CODEX_CHATGPT_WEB_HOME: coreHome,
  });
  assert.equal(settings.sourcePath, configPath);
  assert.equal(settings.profileId, "profile_87654321");
  assert.equal(settings.dataDir, dataDir);
  assert.equal(settings.autoOpen, true);
  assert.equal(settings.apiHost, "http://127.0.0.1:50000");
  assert.equal(settings.apiKeyFile, apiKeyFile);
});

test("launcher state is enriched with matching core auto-open credentials metadata", async (t) => {
  const root = join(tmpdir(), `devspace-roxy-merge-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const userData = join(root, "AsterBridge");
  const coreHome = join(root, "core");
  const dataDir = join(root, "roxy-data");
  const apiKeyFile = join(root, "secrets", "roxy-browser-api.key");
  await mkdir(userData, { recursive: true });
  await mkdir(coreHome, { recursive: true });
  await mkdir(dataDir, { recursive: true });
  const statePath = join(userData, "launcher-state.json");
  const configPath = join(coreHome, "config.json");
  await writeFile(statePath, JSON.stringify({
    useRoxyBrowser: true,
    roxyBrowserProfileId: "profile_merged123",
    roxyBrowserDataDir: dataDir,
  }));
  await writeFile(configPath, JSON.stringify({
    turnBrowserHost: "roxybrowser",
    roxyBrowserProfileId: "profile_merged123",
    roxyBrowserDataDir: dataDir,
    roxyBrowserAutoOpen: true,
    roxyBrowserApiHost: "http://127.0.0.1:50001",
    roxyBrowserApiKeyFile: apiKeyFile,
  }));
  t.after(() => rm(root, { recursive: true, force: true }));

  const settings = discoverAsterBridgeRoxySettings({
    ASTERBRIDGE_LAUNCHER_STATE: statePath,
    CODEX_CHATGPT_WEB_HOME: coreHome,
  });
  assert.equal(settings.sourcePath, statePath);
  assert.equal(settings.autoOpen, true);
  assert.equal(settings.apiHost, "http://127.0.0.1:50001");
  assert.equal(settings.apiKeyFile, apiKeyFile);
});

test("DevToolsActivePort parser fails closed", () => {
  assert.deepEqual(
    parseDevToolsActivePort("49201\n/devtools/browser/abc123\n"),
    { port: 49201, path: "/devtools/browser/abc123" },
  );
  assert.equal(parseDevToolsActivePort("0\n/devtools/browser/abc\n"), undefined);
  assert.equal(parseDevToolsActivePort("49201\n/not-devtools\n"), undefined);
  assert.equal(parseDevToolsActivePort("garbage"), undefined);
});

test("normal Goal chats never alias AsterBridge Temporary Chat", () => {
  assert.equal(sameConversationUrl("https://chatgpt.com/", "https://chatgpt.com/?temporary-chat=true"), false);
  assert.equal(sameConversationUrl("https://chatgpt.com/", "https://chatgpt.com/?model=gpt-5"), true);
  assert.equal(sameConversationUrl("https://chatgpt.com/c/abc", "https://chatgpt.com/c/abc?model=gpt-5"), true);
  assert.equal(sameConversationUrl("https://chatgpt.com/c/abc", "https://chatgpt.com/c/def"), false);
});
