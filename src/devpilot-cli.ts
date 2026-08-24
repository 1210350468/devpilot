#!/usr/bin/env node
import { loadConfig } from "./config.js";
import { DevPilotSupervisor, loadDevPilotSupervisorConfig } from "./devpilot-supervisor.js";

async function main(argv: string[]): Promise<void> {
  const first = argv[0];
  const command = first && !first.startsWith("-") ? first : undefined;
  const args = command ? argv.slice(1) : argv;
  if (command === "help" || first === "--help" || first === "-h") {
    printHelp();
    return;
  }
  if (command && command !== "start" && command !== "serve") {
    throw new Error(`Unknown DevPilot command: ${command}`);
  }

  const serverConfig = loadConfig();
  const overrides = parseArgs(args);
  const supervisorConfig = {
    ...loadDevPilotSupervisorConfig(process.env, serverConfig),
    ...overrides,
  };
  const supervisor = new DevPilotSupervisor({ serverConfig, supervisorConfig });
  await supervisor.listen();

  console.log("DevPilot 已启动。");
  console.log(`控制端口: http://${supervisorConfig.host}:${supervisorConfig.port}/devpilot/`);
  console.log(`本地 MCP: http://${displayServerHost(serverConfig.host)}:${serverConfig.port}/mcp`);
  console.log(`工具模式: ${serverConfig.toolMode}`);
  console.log(`隧道模式: ${supervisorConfig.tunnelProvider}`);
  console.log(`自动启动: ${supervisorConfig.autoStart ? "已开启" : "已关闭"}`);

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await supervisor.close();
    process.exit(0);
  };
  const handleShutdown = () => {
    void shutdown().catch((error) => {
      console.error("DevPilot shutdown failed", error);
      process.exit(1);
    });
  };
  process.once("SIGINT", handleShutdown);
  process.once("SIGTERM", handleShutdown);
}

function parseArgs(args: string[]): Partial<ReturnType<typeof loadDevPilotSupervisorConfig>> {
  const overrides: Partial<ReturnType<typeof loadDevPilotSupervisorConfig>> = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--no-autostart") {
      overrides.autoStart = false;
      continue;
    }
    if (arg === "--autostart") {
      overrides.autoStart = true;
      continue;
    }
    if (arg === "--control-port") {
      const value = args[++index];
      const port = Number(value);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error(`Invalid --control-port: ${value ?? "missing"}`);
      }
      overrides.port = port;
      continue;
    }
    if (arg === "--tunnel") {
      const value = args[++index];
      if (value !== "none" && value !== "external" && value !== "cloudflare-quick" && value !== "openai-secure" && value !== "managed-command") {
        throw new Error(`Invalid --tunnel provider: ${value ?? "missing"}`);
      }
      overrides.tunnelProvider = value;
      continue;
    }
    if (arg === "--cloudflared") {
      const value = args[++index]?.trim();
      if (!value) throw new Error("Missing --cloudflared command.");
      overrides.cloudflaredCommand = value;
      continue;
    }
    if (arg === "--tunnel-client") {
      const value = args[++index]?.trim();
      if (!value) throw new Error("Missing --tunnel-client command.");
      overrides.openAiTunnelClientCommand = value;
      continue;
    }
    if (arg === "--tunnel-id") {
      const value = args[++index]?.trim();
      if (!value) throw new Error("Missing --tunnel-id value.");
      overrides.openAiTunnelId = value;
      continue;
    }
    if (arg === "--tunnel-health-addr") {
      const value = args[++index]?.trim();
      if (!value) throw new Error("Missing --tunnel-health-addr value.");
      overrides.openAiTunnelHealthAddr = value;
      continue;
    }
    if (arg === "--tunnel-command") {
      const value = args[++index]?.trim();
      if (!value) throw new Error("Missing --tunnel-command value.");
      overrides.managedTunnelCommand = value;
      continue;
    }
    if (arg === "--tunnel-args-json") {
      const value = args[++index];
      if (!value) throw new Error("Missing --tunnel-args-json value.");
      let parsed: unknown;
      try {
        parsed = JSON.parse(value);
      } catch {
        throw new Error("--tunnel-args-json must be a JSON array of strings.");
      }
      if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== "string")) {
        throw new Error("--tunnel-args-json must be a JSON array of strings.");
      }
      overrides.managedTunnelArgs = parsed;
      continue;
    }
    if (arg === "--tunnel-public-url") {
      const value = args[++index]?.trim();
      if (!value) throw new Error("Missing --tunnel-public-url value.");
      try {
        overrides.managedTunnelPublicBaseUrl = new URL(value).toString().replace(/\/$/, "");
      } catch {
        throw new Error(`Invalid --tunnel-public-url: ${value}`);
      }
      continue;
    }
    throw new Error(`Unknown DevPilot option: ${arg}`);
  }
  return overrides;
}

function displayServerHost(host: string): string {
  if (host === "0.0.0.0" || host === "::") return "127.0.0.1";
  if (host.includes(":") && !host.startsWith("[")) return `[${host}]`;
  return host;
}

function printHelp(): void {
  console.log([
    "DevPilot — Local Coding Agent Control Plane",
    "",
    "Usage:",
    "  devpilot                         Start the local Control Center",
    "  devpilot start                   Same as above",
    "  devpilot --no-autostart          Keep MCP/tunnel stopped until started from the UI",
    "  devpilot --control-port 7680     Change the local management port",
    "  devpilot --tunnel none           Do not manage a tunnel",
    "  devpilot --tunnel external       Use the configured DEVSPACE_PUBLIC_BASE_URL",
    "  devpilot --tunnel cloudflare-quick",
    "                                   Manage a Cloudflare Quick Tunnel",
    "  devpilot --tunnel openai-secure  Use OpenAI Secure MCP Tunnel",
    "  devpilot --tunnel-client <path>  Override the tunnel-client executable",
    "  devpilot --tunnel-id <id>        Override the OpenAI tunnel id",
    "  devpilot --cloudflared <path>    Override the cloudflared executable",
    "  devpilot --tunnel managed-command --tunnel-command <exe>",
    "           --tunnel-args-json '[\"arg1\",\"arg2\"]'",
    "           --tunnel-public-url https://mcp.example.com",
    "                                   Manage any long-running tunnel/proxy command",
    "",
    "Environment equivalents:",
    "  DEVPILOT_CONTROL_HOST",
    "  DEVPILOT_CONTROL_PORT",
    "  DEVPILOT_TUNNEL_PROVIDER",
    "  DEVPILOT_CLOUDFLARED",
    "  DEVPILOT_OPENAI_TUNNEL_CLIENT",
    "  DEVPILOT_OPENAI_TUNNEL_ID",
    "  DEVPILOT_OPENAI_TUNNEL_API_KEY",
    "  DEVPILOT_OPENAI_TUNNEL_HEALTH_ADDR",
    "  DEVPILOT_TUNNEL_COMMAND",
    "  DEVPILOT_TUNNEL_ARGS_JSON",
    "  DEVPILOT_TUNNEL_PUBLIC_BASE_URL",
    "  DEVPILOT_AUTOSTART",
  ].join("\n"));
}

main(process.argv.slice(2)).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
