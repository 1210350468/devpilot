import assert from "node:assert/strict";
import test from "node:test";
import { TunnelHealthHistory } from "./connection-diagnostics.js";

test("tunnel health history records only readiness transitions", () => {
  const history = new TunnelHealthHistory(3);
  assert.equal(history.sample(true, "2026-10-05T01:00:00.000Z"), undefined);
  assert.equal(history.sample(true, "2026-10-05T01:00:05.000Z"), undefined);
  assert.deepEqual(history.sample(false, "2026-10-05T01:00:10.000Z"), {
    at: "2026-10-05T01:00:10.000Z",
    ready: false,
  });
  assert.deepEqual(history.sample(true, "2026-10-05T01:00:15.000Z"), {
    at: "2026-10-05T01:00:15.000Z",
    ready: true,
  });

  assert.deepEqual(history.snapshot(), {
    checkedAt: "2026-10-05T01:00:15.000Z",
    ready: true,
    readySince: "2026-10-05T01:00:15.000Z",
    lastTransitionAt: "2026-10-05T01:00:15.000Z",
    transitionCount: 2,
    recentTransitions: [
      { at: "2026-10-05T01:00:15.000Z", ready: true },
      { at: "2026-10-05T01:00:10.000Z", ready: false },
    ],
  });
});

test("tunnel health history bounds retained transitions", () => {
  const history = new TunnelHealthHistory(2);
  history.sample(true, "2026-10-05T01:00:00.000Z");
  history.sample(false, "2026-10-05T01:00:05.000Z");
  history.sample(true, "2026-10-05T01:00:10.000Z");
  history.sample(false, "2026-10-05T01:00:15.000Z");

  const snapshot = history.snapshot();
  assert.equal(snapshot.transitionCount, 3);
  assert.deepEqual(snapshot.recentTransitions.map((entry) => entry.at), [
    "2026-10-05T01:00:15.000Z",
    "2026-10-05T01:00:10.000Z",
  ]);
  assert.equal(snapshot.readySince, undefined);
});
