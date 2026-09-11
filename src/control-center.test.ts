import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import express from "express";
import { isLoopbackAddress, isLoopbackHostname, registerControlCenter } from "./control-center.js";
import { loadConfig } from "./config.js";
import { RequestObserver } from "./request-observer.js";

test("control center accepts only loopback socket addresses", () => {
  assert.equal(isLoopbackAddress("127.0.0.1"), true);
  assert.equal(isLoopbackAddress("::1"), true);
  assert.equal(isLoopbackAddress("::ffff:127.0.0.1"), true);
  assert.equal(isLoopbackAddress("192.168.1.10"), false);
  assert.equal(isLoopbackAddress("10.0.0.8"), false);
  assert.equal(isLoopbackAddress(undefined), false);
});

test("control center rejects public tunnel and arbitrary hostnames", () => {
  assert.equal(isLoopbackHostname("localhost"), true);
  assert.equal(isLoopbackHostname("LOCALHOST"), true);
  assert.equal(isLoopbackHostname("127.0.0.1"), true);
  assert.equal(isLoopbackHostname("[::1]"), true);
  assert.equal(isLoopbackHostname("example.trycloudflare.com"), false);
  assert.equal(isLoopbackHostname("devpilot.example.com"), false);
  assert.equal(isLoopbackHostname(undefined), false);
});

test("control center persists OAuth resource aliases", async () => {
  const configDir = await mkdtemp(join(tmpdir(), "devpilot-control-settings-test-"));
  const previousConfigDir = process.env.DEVSPACE_CONFIG_DIR;
  process.env.DEVSPACE_CONFIG_DIR = configDir;
  const config = loadConfig({
    DEVSPACE_CONFIG_DIR: configDir,
    DEVSPACE_ALLOWED_ROOTS: process.cwd(),
    DEVSPACE_OAUTH_OWNER_TOKEN: "control-center-alias-owner-token",
    DEVSPACE_OAUTH_ALLOWED_RESOURCE_URLS: "https://initial.example.com/mcp",
    HOST: "127.0.0.1",
    PORT: "7676",
  });
  const app = express();
  registerControlCenter({
    app,
    config,
    requestObserver: new RequestObserver(),
    localAgentProviders: [],
    uiBuildDirectory: process.cwd(),
  });
  const httpServer = app.listen(0, "127.0.0.1");

  try {
    await new Promise<void>((resolve, reject) => {
      httpServer.once("listening", resolve);
      httpServer.once("error", reject);
    });
    const address = httpServer.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const settings = await fetch(`${baseUrl}/devpilot/api/settings`);
    assert.equal(settings.status, 200);
    const payload = await settings.json() as {
      effective?: { oauthAllowedResourceUrls?: string[] };
    };
    assert.deepEqual(payload.effective?.oauthAllowedResourceUrls, ["https://initial.example.com/mcp"]);

    const save = await fetch(`${baseUrl}/devpilot/api/settings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        oauthAllowedResourceUrls: ["https://tunnel.example.com/v1/mcp/tunnel_123"],
      }),
    });
    assert.equal(save.status, 200);
    const saved = JSON.parse(await readFile(join(configDir, "config.json"), "utf8")) as {
      oauthAllowedResourceUrls?: string[];
    };
    assert.deepEqual(saved.oauthAllowedResourceUrls, ["https://tunnel.example.com/v1/mcp/tunnel_123"]);

    const badSave = await fetch(`${baseUrl}/devpilot/api/settings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ oauthAllowedResourceUrls: ["http://example.com/mcp"] }),
    });
    assert.equal(badSave.status, 400);
    const unchanged = JSON.parse(await readFile(join(configDir, "config.json"), "utf8")) as {
      oauthAllowedResourceUrls?: string[];
    };
    assert.deepEqual(unchanged.oauthAllowedResourceUrls, ["https://tunnel.example.com/v1/mcp/tunnel_123"]);
  } finally {
    await new Promise<void>((resolve, reject) => {
      httpServer.close((error) => error ? reject(error) : resolve());
    });
    if (previousConfigDir === undefined) delete process.env.DEVSPACE_CONFIG_DIR;
    else process.env.DEVSPACE_CONFIG_DIR = previousConfigDir;
    await rm(configDir, { recursive: true, force: true });
  }
});

test("local status API is reachable without exposing control-plane secrets", async () => {
  const ownerToken = "control-center-owner-token-test-value";
  const config = loadConfig({
    DEVSPACE_CONFIG_DIR: ".devpilot-test-config",
    DEVSPACE_ALLOWED_ROOTS: process.cwd(),
    DEVSPACE_TOOL_MODE: "full",
    DEVSPACE_OAUTH_OWNER_TOKEN: ownerToken,
    HOST: "127.0.0.1",
    PORT: "7676",
  });
  const app = express();
  registerControlCenter({
    app,
    config,
    requestObserver: new RequestObserver(),
    localAgentProviders: [],
    uiBuildDirectory: process.cwd(),
  });
  const httpServer = app.listen(0, "127.0.0.1");
  try {
    await new Promise<void>((resolve, reject) => {
      httpServer.once("listening", resolve);
      httpServer.once("error", reject);
    });
    const address = httpServer.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const bareRoute = await fetch(`${baseUrl}/devpilot`, { redirect: "manual" });
    assert.equal(bareRoute.status, 308);
    assert.equal(bareRoute.headers.get("location"), "/devpilot/");
    const slashRoute = await fetch(`${baseUrl}/devpilot/`, { redirect: "manual" });
    assert.notEqual(slashRoute.status, 308);
    assert.equal(slashRoute.headers.get("location"), null);

    const response = await fetch(`${baseUrl}/devpilot/api/status`);
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.equal(text.includes(ownerToken), false);
    assert.equal(/authToken|ownerToken|daemon.*secret/i.test(text), false);
    const payload = JSON.parse(text) as { product?: string; server?: { toolMode?: string }; requestObserver?: { enabled?: boolean } };
    assert.equal(payload.product, "DevPilot");
    assert.equal(payload.server?.toolMode, "full");
    assert.equal(payload.requestObserver?.enabled, true);
  } finally {
    await new Promise<void>((resolve, reject) => {
      httpServer.close((error) => error ? reject(error) : resolve());
    });
  }
});
