import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
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
