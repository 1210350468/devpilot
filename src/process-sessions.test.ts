import assert from "node:assert/strict";
import { HeadTailBuffer, ProcessSessionManager } from "./process-sessions.js";

const smallBuffer = new HeadTailBuffer(100);
smallBuffer.append("hello\n");
assert.deepEqual(smallBuffer.drain(100), { output: "hello\n", truncated: false });
assert.deepEqual(smallBuffer.drain(100), { output: "", truncated: false });

const headTail = new HeadTailBuffer(10);
headTail.append("start-middle-end");
const headTailResult = headTail.drain(1_000);
assert.equal(headTailResult.truncated, true);
assert.match(headTailResult.output, /^start/);
assert.match(headTailResult.output, /e-end$/);
assert.match(headTailResult.output, /characters omitted/);

const responseLimited = new HeadTailBuffer(100);
responseLimited.append("abcdef".repeat(20));
const responseLimitedResult = responseLimited.drain(40);
assert.equal(responseLimitedResult.truncated, true);
assert.match(responseLimitedResult.output, /^abc/);
assert.match(responseLimitedResult.output, /def$/);

const unicodeBuffer = new HeadTailBuffer(4);
unicodeBuffer.append("a🙂b🙂c");
const unicodeResult = unicodeBuffer.drain(1_000);
assert.equal(unicodeResult.truncated, true);
assert.match(unicodeResult.output, /^a🙂/);
assert.match(unicodeResult.output, /🙂c$/);

const manager = new ProcessSessionManager({
  maxBufferCharacters: 1_024,
  completedSessionTtlMs: 1_000,
});

const node = process.platform === "win32"
  ? `"${process.execPath}"`
  : JSON.stringify(process.execPath);

const foreground = await manager.start({
  workspaceId: "workspace-a",
  cwd: process.cwd(),
  command: `${node} -e "console.log('foreground')"`,
  yieldTimeMs: 2_000,
});
assert.equal(foreground.running, false);
assert.equal(foreground.exitCode, 0);
assert.match(foreground.output, /foreground/);
assert.equal(foreground.sessionId, undefined);

const environment = await manager.start({
  workspaceId: "workspace-a",
  workspaceRoot: "/tmp/devspace-workspace-a",
  cwd: process.cwd(),
  command: `${node} -e "console.log([process.env.NO_COLOR, process.env.TERM, process.env.PAGER, process.env.GIT_PAGER, process.env.GH_PAGER, process.env.CODEX_CI, process.env.DEVSPACE_WORKSPACE_ID, process.env.DEVSPACE_WORKSPACE_ROOT].join(','))"`,
  yieldTimeMs: 2_000,
});
assert.equal(environment.running, false);
assert.match(environment.output, /1,dumb,cat,cat,cat,1,workspace-a,\/tmp\/devspace-workspace-a/);

const background = await manager.start({
  workspaceId: "workspace-a",
  cwd: process.cwd(),
  command: `${node} -e "setTimeout(() => console.log('finished'), 100)"`,
  yieldTimeMs: 5,
});
assert.equal(background.running, true);
assert.ok(background.sessionId);
assert.equal(typeof background.sessionId, "number");

await assert.rejects(
  manager.write({
    workspaceId: "workspace-b",
    sessionId: background.sessionId,
    yieldTimeMs: 1,
  }),
  /does not belong to workspace/,
);

const completed = await manager.write({
  workspaceId: "workspace-a",
  sessionId: background.sessionId,
  yieldTimeMs: 2_000,
});
assert.equal(completed.running, false);
assert.equal(completed.exitCode, 0);
assert.match(completed.output, /finished/);

const defaultLongStartedAt = Date.now();
const defaultLong = await manager.start({
  workspaceId: "workspace-a",
  cwd: process.cwd(),
  command: `${node} -e "setTimeout(() => process.exit(0), 10000)"`,
});
const defaultLongElapsedMs = Date.now() - defaultLongStartedAt;
assert.equal(defaultLong.running, true);
assert.ok(defaultLong.sessionId);
assert.ok(
  defaultLong.wallTimeMs >= 1_500,
  `default long-command yield returned too early: ${defaultLong.wallTimeMs}ms`,
);
assert.ok(
  defaultLongElapsedMs < 5_000,
  `default long-command feedback was too slow: ${defaultLongElapsedMs}ms`,
);
manager.terminate("workspace-a", defaultLong.sessionId);

const interactive = await manager.start({
  workspaceId: "workspace-a",
  cwd: process.cwd(),
  command: `${node} -e "process.stdin.once('data', data => { console.log('input:' + data.toString().trim()); process.exit(0); })"`,
  yieldTimeMs: 5,
});
assert.equal(interactive.running, true);
assert.ok(interactive.sessionId);
assert.equal(typeof interactive.sessionId, "number");

const inputResult = await manager.write({
  workspaceId: "workspace-a",
  sessionId: interactive.sessionId,
  chars: "hello\n",
  yieldTimeMs: 2_000,
});
assert.equal(inputResult.running, false);
assert.match(inputResult.output, /input:hello/);

const defaultInteractive = await manager.start({
  workspaceId: "workspace-a",
  cwd: process.cwd(),
  command: `${node} -e "process.stdin.once('data', data => setTimeout(() => { console.log('default-input:' + data.toString().trim()); process.exit(0); }, 100))"`,
  yieldTimeMs: 5,
});
assert.equal(defaultInteractive.running, true);
assert.ok(defaultInteractive.sessionId);

const defaultInputResult = await manager.write({
  workspaceId: "workspace-a",
  sessionId: defaultInteractive.sessionId,
  chars: "hello\n",
});
assert.equal(defaultInputResult.running, false);
assert.match(defaultInputResult.output, /default-input:hello/);

const noisyInteractive = await manager.start({
  workspaceId: "workspace-a",
  cwd: process.cwd(),
  command: `${node} -e "setInterval(() => console.log('tick'), 10); process.stdin.once('data', data => { console.log('input:' + data.toString().trim()); process.exit(0); })"`,
  yieldTimeMs: 100,
});
assert.equal(noisyInteractive.running, true);
assert.ok(noisyInteractive.sessionId);

await new Promise((resolve) => setTimeout(resolve, 50));
const noisyInputResult = await manager.write({
  workspaceId: "workspace-a",
  sessionId: noisyInteractive.sessionId,
  chars: "hello\n",
  yieldTimeMs: 2_000,
});
assert.equal(noisyInputResult.running, false);
assert.match(noisyInputResult.output, /input:hello/);

const interruptible = await manager.start({
  workspaceId: "workspace-a",
  cwd: process.cwd(),
  command: `${node} -e "setInterval(() => console.log('tick'), 10)"`,
  yieldTimeMs: 100,
});
assert.equal(interruptible.running, true);
assert.ok(interruptible.sessionId);

await new Promise((resolve) => setTimeout(resolve, 50));
const interrupted = await manager.write({
  workspaceId: "workspace-a",
  sessionId: interruptible.sessionId,
  chars: "\u0003",
  yieldTimeMs: 2_000,
});
assert.equal(interrupted.running, false);
if (process.platform !== "win32") assert.equal(interrupted.signal, "SIGINT");

let buffered = await manager.start({
  workspaceId: "workspace-a",
  cwd: process.cwd(),
  command: `${node} -e "console.log('x'.repeat(5000)); setTimeout(() => {}, 100)"`,
  yieldTimeMs: 50,
  maxOutputTokens: 100,
});
if (!buffered.outputTruncated && buffered.sessionId) {
  buffered = await manager.write({
    workspaceId: "workspace-a",
    sessionId: buffered.sessionId,
    yieldTimeMs: 2_000,
    maxOutputTokens: 100,
  });
}
assert.equal(buffered.outputTruncated, true);
if (buffered.sessionId) manager.terminate("workspace-a", buffered.sessionId);

const lifecycleManager = new ProcessSessionManager({
  maxBufferCharacters: 1_024,
  completedSessionTtlMs: 2_000,
  idleSessionTimeoutMs: 80,
  terminationGraceMs: 50,
});

const abandoned = await lifecycleManager.start({
  workspaceId: "workspace-lifecycle",
  cwd: process.cwd(),
  command: `${node} -e "setTimeout(() => {}, 5000)"`,
  yieldTimeMs: 5,
});
assert.equal(abandoned.running, true);
assert.ok(abandoned.sessionId);
await new Promise((resolve) => setTimeout(resolve, 250));
const autoClosed = await lifecycleManager.write({
  workspaceId: "workspace-lifecycle",
  sessionId: abandoned.sessionId,
  yieldTimeMs: 20,
});
assert.equal(autoClosed.running, false);

const renewed = await lifecycleManager.start({
  workspaceId: "workspace-lifecycle",
  cwd: process.cwd(),
  command: `${node} -e "setTimeout(() => process.exit(0), 260)"`,
  yieldTimeMs: 5,
});
assert.ok(renewed.sessionId);
await new Promise((resolve) => setTimeout(resolve, 55));
const renewedOnce = await lifecycleManager.write({
  workspaceId: "workspace-lifecycle",
  sessionId: renewed.sessionId,
  yieldTimeMs: 0,
});
assert.equal(renewedOnce.running, true);
await new Promise((resolve) => setTimeout(resolve, 55));
const renewedTwice = await lifecycleManager.write({
  workspaceId: "workspace-lifecycle",
  sessionId: renewed.sessionId,
  yieldTimeMs: 0,
});
assert.equal(renewedTwice.running, true);
const renewedCompleted = await lifecycleManager.write({
  workspaceId: "workspace-lifecycle",
  sessionId: renewed.sessionId,
  yieldTimeMs: 500,
});
assert.equal(renewedCompleted.running, false);
assert.equal(renewedCompleted.exitCode, 0);

const persistent = await lifecycleManager.start({
  workspaceId: "workspace-lifecycle",
  cwd: process.cwd(),
  command: `${node} -e "setTimeout(() => {}, 5000)"`,
  yieldTimeMs: 5,
  autoClose: false,
});
assert.ok(persistent.sessionId);
await new Promise((resolve) => setTimeout(resolve, 180));
const stillPersistent = await lifecycleManager.write({
  workspaceId: "workspace-lifecycle",
  sessionId: persistent.sessionId,
  yieldTimeMs: 0,
});
assert.equal(stillPersistent.running, true);
lifecycleManager.terminate("workspace-lifecycle", persistent.sessionId);

const hardLimited = await lifecycleManager.start({
  workspaceId: "workspace-lifecycle",
  cwd: process.cwd(),
  command: `${node} -e "setTimeout(() => {}, 5000)"`,
  yieldTimeMs: 5,
  autoClose: false,
  maxRuntimeMs: 80,
});
assert.ok(hardLimited.sessionId);
await new Promise((resolve) => setTimeout(resolve, 250));
const hardStopped = await lifecycleManager.write({
  workspaceId: "workspace-lifecycle",
  sessionId: hardLimited.sessionId,
  yieldTimeMs: 20,
});
assert.equal(hardStopped.running, false);

const detached = await lifecycleManager.start({
  workspaceId: "workspace-lifecycle",
  cwd: process.cwd(),
  command: `${node} -e "console.log('detached-started'); setTimeout(() => {}, 800)"`,
  yieldTimeMs: 200,
  detach: true,
});
assert.equal(detached.running, false);
assert.equal(detached.detached, true);
assert.equal(detached.sessionId, undefined);
assert.match(detached.output, /detached-started/);

await assert.rejects(
  lifecycleManager.start({
    workspaceId: "workspace-lifecycle",
    cwd: process.cwd(),
    command: "echo invalid",
    tty: true,
    detach: true,
  }),
  /cannot allocate an interactive PTY/,
);
lifecycleManager.shutdown();

try {
  if (process.platform === "win32") {
    const pty = await manager.start({
      workspaceId: "workspace-a",
      cwd: process.cwd(),
      command: "echo pty-ok",
      tty: true,
      yieldTimeMs: 10_000,
    });
    assert.equal(pty.running, false);
    assert.match(pty.output, /pty-ok/);
  } else {
    const pty = await manager.start({
      workspaceId: "workspace-a",
      cwd: process.cwd(),
      command: `${node} -e "setTimeout(() => console.log('columns:' + process.stdout.columns), 250)"`,
      tty: true,
      columns: 80,
      rows: 24,
      yieldTimeMs: 10,
    });
    assert.equal(pty.running, true);
    assert.ok(pty.sessionId);

    const resizedPty = await manager.write({
      workspaceId: "workspace-a",
      sessionId: pty.sessionId,
      columns: 120,
      rows: 30,
      yieldTimeMs: 2_000,
    });
    assert.equal(resizedPty.running, false);
    assert.match(resizedPty.output, /columns:120/);
  }
} finally {
  manager.shutdown();
}
