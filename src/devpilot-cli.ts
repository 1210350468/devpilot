#!/usr/bin/env node
import { loadConfig } from "./config.js";
import { DevPilotSupervisor, loadDevPilotSupervisorConfig } from "./devpilot-supervisor.js";

async function main(): Promise<void> {
  const serverConfig = loadConfig();
  const supervisor = new DevPilotSupervisor(serverConfig, loadDevPilotSupervisorConfig(process.env));
  await supervisor.listen();
  const status = await supervisor.status();
  console.log("DevPilot upstream-first runtime started.");
  console.log(`Control Center: http://${status.supervisor.host}:${status.supervisor.port}/devpilot/`);
  console.log(`MCP: ${status.server.localMcpUrl}`);
  console.log(`Tool surface: ${status.server.toolMode}`);
  console.log(`Tunnel: ${status.tunnel.provider}`);

  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    await supervisor.close();
    process.exit(0);
  };
  const handle = () => void shutdown().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exit(1);
  });
  process.once("SIGINT", handle);
  process.once("SIGTERM", handle);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
