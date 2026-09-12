import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import "./control-center.css";

type View = "overview" | "requests" | "settings";
type ServiceAction = "start" | "restart" | "stop";

interface StatusResponse {
  product: string;
  architecture: "upstream-first";
  supervisor: { status: string; host: string; port: number; pid: number };
  server: {
    status: string;
    state: string;
    pid?: number;
    startedAt?: string;
    error?: string;
    toolMode: "codex" | "claude";
    tools: string[];
    host: string;
    port: number;
    localMcpUrl: string;
  };
  tunnel: {
    provider: string;
    state: string;
    pid?: number;
    startedAt?: string;
    error?: string;
    tunnelId?: string;
    healthUrl?: string;
    ready?: boolean;
  };
  providers: Array<{ name: string; available: boolean; note?: string; reason?: string }>;
  requestObserver: { enabled: boolean; retained: number };
  events: Array<{ at: string; level: "info" | "warn" | "error"; message: string }>;
}

interface SettingsResponse {
  configPath: string;
  restartRequired: boolean;
  effective: {
    host: string;
    port: number;
    allowedRoots: string[];
    authMode: "oauth" | "secure-tunnel";
    toolMode: "codex" | "claude";
    uiEnabled: boolean;
    artifactsEnabled: boolean;
    skillsEnabled: boolean;
    subagentsEnabled: boolean;
    publicBaseUrl: string;
    loggingRequests: boolean;
    loggingToolCalls: boolean;
  };
  runtime: {
    host: string;
    port: number;
    allowedRoots: string[];
    toolMode: "codex" | "claude";
  };
}

interface ObservedRequest {
  id: string;
  startedAt: string;
  completedAt?: string;
  method: string;
  path: string;
  status?: number;
  durationMs?: number;
  host?: string;
  userAgent?: string;
  mcpMethod?: string;
  toolName?: string;
  paramsPreview?: string;
  conversationScopeId?: string;
  mcpSessionId?: string;
}

interface ObservedConversation {
  id: string;
  firstSeenAt: string;
  lastSeenAt: string;
  requestCount: number;
  toolCallCount: number;
  runningCount: number;
  lastToolName?: string;
}

function App() {
  const [view, setView] = useState<View>("overview");
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [settings, setSettings] = useState<SettingsResponse | null>(null);
  const [requests, setRequests] = useState<ObservedRequest[]>([]);
  const [conversations, setConversations] = useState<ObservedConversation[]>([]);
  const [selectedConversationId, setSelectedConversationId] = useState<string>();
  const [selectedRequest, setSelectedRequest] = useState<ObservedRequest | null>(null);
  const [error, setError] = useState<string>();
  const [busyAction, setBusyAction] = useState<ServiceAction>();
  const [updatedAt, setUpdatedAt] = useState<Date>();

  const refresh = async () => {
    try {
      const [nextStatus, nextSettings, nextRequests, nextConversations] = await Promise.all([
        fetchJson<StatusResponse>("/devpilot/api/status"),
        fetchJson<SettingsResponse>("/devpilot/api/settings"),
        fetchJson<{ requests: ObservedRequest[] }>("/devpilot/api/requests?limit=200"),
        fetchJson<{ conversations: ObservedConversation[] }>("/devpilot/api/conversations"),
      ]);
      setStatus(nextStatus);
      setSettings(nextSettings);
      setRequests(nextRequests.requests);
      setConversations(nextConversations.conversations);
      setUpdatedAt(new Date());
      setError(undefined);
      if (selectedRequest) {
        const updated = nextRequests.requests.find((request) => request.id === selectedRequest.id);
        if (updated) setSelectedRequest(updated);
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 1500);
    return () => window.clearInterval(timer);
  }, []);

  const act = async (action: ServiceAction) => {
    setBusyAction(action);
    try {
      const response = await fetch(`/devpilot/api/services/${action}`, {
        method: "POST",
        headers: { "x-devpilot-control": "1" },
      });
      if (!response.ok) throw new Error(await response.text());
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusyAction(undefined);
    }
  };

  const mcpRequests = useMemo(() => requests.filter((request) => request.path === "/mcp"), [requests]);
  const toolCalls = useMemo(() => mcpRequests.filter((request) => request.toolName), [mcpRequests]);
  const visibleRequests = useMemo(
    () => selectedConversationId
      ? mcpRequests.filter((request) => request.conversationScopeId === selectedConversationId)
      : mcpRequests,
    [mcpRequests, selectedConversationId],
  );
  const unidentifiedCount = useMemo(
    () => mcpRequests.filter((request) => !request.conversationScopeId).length,
    [mcpRequests],
  );
  const availableProviders = status?.providers.filter((provider) => provider.available).length ?? 0;
  const ready = status?.server.status === "online" && (status?.tunnel.provider === "none" || status?.tunnel.ready === true);

  return (
    <div className="dp-shell">
      <aside className="dp-sidebar">
        <div className="brand">
          <div className="brand-mark">DP</div>
          <div><strong>DevPilot</strong><span>Upstream-first Control Center</span></div>
        </div>
        <nav className="nav">
          <NavButton label="总览" active={view === "overview"} onClick={() => setView("overview")} />
          <NavButton label="请求观察器" badge={toolCalls.length || undefined} active={view === "requests"} onClick={() => setView("requests")} />
          <NavButton label="设置" active={view === "settings"} onClick={() => setView("settings")} />
        </nav>
        <div className="sidebar-footer">
          <div className="connection-row"><span className={`status-dot ${ready ? "ok" : "off"}`} />{ready ? "运行正常" : "需要检查"}</div>
          <small>{updatedAt ? `更新于 ${updatedAt.toLocaleTimeString()}` : "正在连接…"}</small>
        </div>
      </aside>

      <main className="dp-main">
        <header className="topbar">
          <div>
            <p className="eyebrow">DEVSPACE · UPSTREAM-FIRST</p>
            <h1>{view === "overview" ? "总览" : view === "requests" ? "ChatGPT 请求观察器" : "设置"}</h1>
          </div>
          <div className="top-actions">
            <span className="mode-pill">{status?.server.toolMode ?? "—"}</span>
            <button className="runtime-button start" disabled={Boolean(busyAction)} onClick={() => void act("start")}>启动</button>
            <button className="runtime-button" disabled={Boolean(busyAction)} onClick={() => void act("restart")}>重启</button>
            <button className="runtime-button stop" disabled={Boolean(busyAction)} onClick={() => void act("stop")}>停止</button>
            <button className="refresh-button" onClick={() => void refresh()}>刷新</button>
          </div>
        </header>

        {error && <div className="error-banner"><strong>错误</strong><span>{error}</span></div>}

        {view === "overview" && (
          <div className="view-stack">
            <section className="metric-grid">
              <Metric label="MCP Server" value={status?.server.status === "online" ? "在线" : "离线"} detail={status?.server.localMcpUrl ?? "—"} />
              <Metric label="Tunnel" value={status?.tunnel.ready ? "READY" : status?.tunnel.state ?? "—"} detail={status?.tunnel.tunnelId ?? "未配置"} />
              <Metric label="已识别对话" value={conversations.length} detail="按 openai/session 分组" />
              <Metric label="工具调用" value={toolCalls.length} detail={`保留请求 ${status?.requestObserver.retained ?? 0}`} />
            </section>

            <section className="system-grid">
              <Panel title="连接与工具" subtitle="当前真实运行的 upstream DevSpace surface">
                <InfoRow label="架构" value={status?.architecture ?? "—"} />
                <InfoRow label="工具模式" value={status?.server.toolMode ?? "—"} />
                <InfoRow label="MCP PID" value={String(status?.server.pid ?? "—")} />
                <InfoRow label="本地 MCP" value={status?.server.localMcpUrl ?? "—"} mono />
                <InfoRow label="Tunnel" value={status?.tunnel.ready ? "READY" : status?.tunnel.state ?? "—"} />
                <InfoRow label="Tunnel Health" value={status?.tunnel.healthUrl ?? "—"} mono />
                <div className="tool-list">{(status?.server.tools ?? []).map((tool) => <code key={tool}>{tool}</code>)}</div>
              </Panel>
              <Panel title="Provider" subtitle={`${availableProviders}/${status?.providers.length ?? 0} 个后端可用`}>
                <div className="provider-list">
                  {(status?.providers ?? []).map((provider) => (
                    <div className="provider-row" key={provider.name}>
                      <span className={`status-dot ${provider.available ? "ok" : "off"}`} />
                      <div><strong>{provider.name}</strong><span>{provider.note ?? provider.reason ?? (provider.available ? "可用" : "不可用")}</span></div>
                    </div>
                  ))}
                </div>
              </Panel>
            </section>

            <section className="system-grid lower-grid">
              <Panel title="最近 MCP 请求" subtitle="来自 ChatGPT / MCP Host 的真实请求">
                <RequestTable requests={mcpRequests.slice(0, 10)} selectedId={selectedRequest?.id} onSelect={(request) => { setSelectedRequest(request); setView("requests"); }} />
              </Panel>
              <Panel title="运行事件" subtitle="Supervisor / Tunnel 生命周期">
                <div className="event-list">
                  {(status?.events ?? []).slice(0, 12).map((event, index) => (
                    <div className={`event-row ${event.level}`} key={`${event.at}-${index}`}>
                      <time>{new Date(event.at).toLocaleTimeString()}</time><span>{event.message}</span>
                    </div>
                  ))}
                </div>
              </Panel>
            </section>
          </div>
        )}

        {view === "requests" && (
          <div className="conversation-request-layout">
            <section className="conversation-list-panel">
              <div className="section-heading"><div><h2>ChatGPT 对话</h2><p>按 openai/session 分组。</p></div><span className="count-chip">{conversations.length}</span></div>
              <ConversationList
                conversations={conversations}
                selectedId={selectedConversationId}
                unidentifiedCount={unidentifiedCount}
                onSelect={(id) => { setSelectedConversationId(id); setSelectedRequest(null); }}
              />
            </section>
            <section className="request-list-panel">
              <div className="section-heading"><div><h2>{selectedConversationId ? "当前对话请求" : "全部 MCP 请求"}</h2><p>{selectedConversationId ? shortId(selectedConversationId) : "initialize / tools/list / tools/call 等"}</p></div><span className="count-chip">{visibleRequests.length}</span></div>
              <RequestTable requests={visibleRequests} selectedId={selectedRequest?.id} onSelect={setSelectedRequest} />
            </section>
            <section className="request-detail-panel">
              {selectedRequest ? <RequestDetail request={selectedRequest} /> : <div className="empty-state padded">选择一条请求查看工具、参数、Session 与耗时。</div>}
            </section>
          </div>
        )}

        {view === "settings" && (
          <SettingsView settings={settings} status={status} onSaved={() => void refresh()} onRestart={() => act("restart")} />
        )}
      </main>
    </div>
  );
}

function NavButton({ label, active, badge, onClick }: { label: string; active: boolean; badge?: number; onClick: () => void }) {
  return <button className={`nav-button ${active ? "active" : ""}`} onClick={onClick}><span>{label}</span>{badge ? <em>{badge}</em> : null}</button>;
}

function Metric({ label, value, detail }: { label: string; value: string | number; detail: string }) {
  return <div className="metric"><span>{label}</span><strong>{value}</strong><p>{detail}</p></div>;
}

function Panel({ title, subtitle, children }: React.PropsWithChildren<{ title: string; subtitle?: string }>) {
  return <section className="panel"><div className="panel-heading"><h2>{title}</h2>{subtitle && <p>{subtitle}</p>}</div>{children}</section>;
}

function InfoRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return <div className="status-line"><div><span>{label}</span></div><strong className={mono ? "mono" : ""}>{value}</strong></div>;
}

function ConversationList({ conversations, selectedId, unidentifiedCount, onSelect }: { conversations: ObservedConversation[]; selectedId?: string; unidentifiedCount: number; onSelect: (id?: string) => void }) {
  const total = conversations.reduce((sum, conversation) => sum + conversation.requestCount, 0) + unidentifiedCount;
  return <div className="conversation-list">
    <button className={`conversation-item ${selectedId === undefined ? "active" : ""}`} onClick={() => onSelect(undefined)}>
      <div><strong>全部对话</strong><span>全部 MCP 请求</span></div><em>{total}</em>
    </button>
    {conversations.map((conversation) => (
      <button key={conversation.id} className={`conversation-item ${selectedId === conversation.id ? "active" : ""}`} onClick={() => onSelect(conversation.id)}>
        <div><strong>{shortId(conversation.id)}</strong><span>{conversation.lastToolName ? `最近：${conversation.lastToolName}` : "已识别对话"}</span></div>
        <div className="conversation-meta"><em>{conversation.toolCallCount}</em><span>{new Date(conversation.lastSeenAt).toLocaleTimeString()}</span></div>
      </button>
    ))}
    {unidentifiedCount > 0 && <div className="conversation-item unidentified"><div><strong>未识别会话</strong><span>初始化或没有 openai/session 的请求</span></div><em>{unidentifiedCount}</em></div>}
  </div>;
}

function RequestTable({ requests, onSelect, selectedId }: { requests: ObservedRequest[]; onSelect: (request: ObservedRequest) => void; selectedId?: string }) {
  if (!requests.length) return <div className="empty-state padded">还没有观察到 MCP 请求。</div>;
  return <div className="table-wrap"><table><thead><tr><th>时间</th><th>类型</th><th>工具</th><th>状态</th><th>耗时</th></tr></thead><tbody>{requests.map((request) => (
    <tr key={request.id} className={selectedId === request.id ? "selected-row" : ""} onClick={() => onSelect(request)}>
      <td>{new Date(request.startedAt).toLocaleTimeString()}</td><td>{request.mcpMethod ?? request.method}</td><td><code>{request.toolName ?? "—"}</code></td><td>{request.status ?? "运行中"}</td><td>{request.durationMs !== undefined ? `${request.durationMs} ms` : "—"}</td>
    </tr>
  ))}</tbody></table></div>;
}

function RequestDetail({ request }: { request: ObservedRequest }) {
  return <div className="request-detail">
    <div className="detail-header"><div><p className="eyebrow">MCP REQUEST</p><h2>{request.toolName ?? request.mcpMethod ?? request.path}</h2></div><span className={`status-badge ${request.status && request.status < 400 ? "completed" : request.status ? "failed" : "running"}`}>{request.status ?? "运行中"}</span></div>
    <div className="detail-grid">
      <Detail label="ChatGPT 对话" value={request.conversationScopeId ? shortId(request.conversationScopeId) : "未识别"} />
      <Detail label="请求 ID" value={request.id} />
      <Detail label="开始时间" value={new Date(request.startedAt).toLocaleString()} />
      <Detail label="HTTP" value={`${request.method} ${request.path}`} />
      <Detail label="耗时" value={request.durationMs !== undefined ? `${request.durationMs} ms` : "—"} />
      <Detail label="MCP 方法" value={request.mcpMethod ?? "—"} />
      <Detail label="工具" value={request.toolName ?? "—"} />
      <Detail label="MCP Session" value={request.mcpSessionId ? shortId(request.mcpSessionId) : "—"} />
    </div>
    <div className="result-box"><span>完整对话 ID</span><pre>{request.conversationScopeId ?? "未提供 openai/session"}</pre></div>
    <div className="result-box"><span>参数摘要</span><pre>{request.paramsPreview ?? "无参数"}</pre></div>
    <div className="result-box"><span>User-Agent</span><pre>{request.userAgent ?? "—"}</pre></div>
  </div>;
}

function Detail({ label, value }: { label: string; value: string }) {
  return <div className="detail-item"><span>{label}</span><strong title={value}>{value}</strong></div>;
}

function SettingsView({ settings, status, onSaved, onRestart }: { settings: SettingsResponse | null; status: StatusResponse | null; onSaved: () => void; onRestart: () => Promise<void> }) {
  const [host, setHost] = useState("127.0.0.1");
  const [port, setPort] = useState("47681");
  const [roots, setRoots] = useState("");
  const [toolMode, setToolMode] = useState<"codex" | "claude">("codex");
  const [uiEnabled, setUiEnabled] = useState(true);
  const [artifactsEnabled, setArtifactsEnabled] = useState(true);
  const [skillsEnabled, setSkillsEnabled] = useState(true);
  const [subagentsEnabled, setSubagentsEnabled] = useState(false);
  const [loggingRequests, setLoggingRequests] = useState(true);
  const [loggingToolCalls, setLoggingToolCalls] = useState(true);
  const [publicBaseUrl, setPublicBaseUrl] = useState("");
  const [message, setMessage] = useState<string>();
  const [restartNeeded, setRestartNeeded] = useState(false);

  useEffect(() => {
    if (!settings) return;
    setHost(settings.effective.host);
    setPort(String(settings.effective.port));
    setRoots(settings.effective.allowedRoots.join("\n"));
    setToolMode(settings.effective.toolMode);
    setUiEnabled(settings.effective.uiEnabled);
    setArtifactsEnabled(settings.effective.artifactsEnabled);
    setSkillsEnabled(settings.effective.skillsEnabled);
    setSubagentsEnabled(settings.effective.subagentsEnabled);
    setLoggingRequests(settings.effective.loggingRequests);
    setLoggingToolCalls(settings.effective.loggingToolCalls);
    setPublicBaseUrl(settings.effective.publicBaseUrl);
  }, [settings?.configPath]);

  const save = async () => {
    setMessage("正在保存…");
    try {
      const response = await fetch("/devpilot/api/settings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          host,
          port: Number(port),
          allowedRoots: roots.split(/\r?\n|,/).map((item) => item.trim()).filter(Boolean),
          toolMode,
          uiEnabled,
          artifactsEnabled,
          skillsEnabled,
          subagentsEnabled,
          loggingRequests,
          loggingToolCalls,
          publicBaseUrl,
        }),
      });
      if (!response.ok) throw new Error(await response.text());
      setMessage("已保存。需要重启 MCP/Tunnel 才会全部生效。");
      setRestartNeeded(true);
      onSaved();
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const restart = async () => {
    setMessage("正在重启并重新读取配置…");
    await onRestart();
    setRestartNeeded(false);
    setMessage("已重启，新配置已加载。");
  };

  return <div className="settings-grid">
    <Panel title="DevSpace 设置" subtitle="这里现在直接映射上游 v1 配置，不再保留旧 minimal/full/widgets 假选项。">
      <label className="form-row"><span>监听地址</span><input value={host} onChange={(event) => setHost(event.target.value)} /></label>
      <label className="form-row"><span>MCP 端口</span><input value={port} inputMode="numeric" onChange={(event) => setPort(event.target.value)} /></label>
      <label className="form-row"><span>工具 Surface</span><select value={toolMode} onChange={(event) => setToolMode(event.target.value as "codex" | "claude")}><option value="codex">Codex：apply_patch + exec_command + write_stdin</option><option value="claude">Claude：write + edit + bash</option></select></label>
      <label className="form-row vertical"><span>允许目录</span><textarea rows={5} value={roots} onChange={(event) => setRoots(event.target.value)} /></label>
      <label className="form-row vertical"><span>Public Base URL</span><input value={publicBaseUrl} onChange={(event) => setPublicBaseUrl(event.target.value)} /></label>
      <Toggle label="MCP App UI" checked={uiEnabled} onChange={setUiEnabled} />
      <Toggle label="Artifacts" checked={artifactsEnabled} onChange={setArtifactsEnabled} />
      <Toggle label="Skills / AGENTS" checked={skillsEnabled} onChange={setSkillsEnabled} />
      <Toggle label="Subagents" checked={subagentsEnabled} onChange={setSubagentsEnabled} />
      <Toggle label="请求日志" checked={loggingRequests} onChange={setLoggingRequests} />
      <Toggle label="工具调用日志" checked={loggingToolCalls} onChange={setLoggingToolCalls} />
      <div className="settings-actions"><button className="refresh-button" onClick={() => void save()}>保存设置</button>{restartNeeded && <button className="runtime-button start" onClick={() => void restart()}>保存并重启</button>}<span>{message ?? ""}</span></div>
    </Panel>
    <Panel title="当前运行状态" subtitle="保存值和当前内存配置可能在重启前不同。">
      <InfoRow label="认证" value={settings?.effective.authMode === "secure-tunnel" ? "OpenAI Secure Tunnel" : "OAuth"} />
      <InfoRow label="运行 Surface" value={settings?.runtime.toolMode ?? "—"} />
      <InfoRow label="运行端口" value={String(settings?.runtime.port ?? "—")} />
      <InfoRow label="Tunnel" value={status?.tunnel.ready ? "READY" : status?.tunnel.state ?? "—"} />
      <InfoRow label="Request Observer" value={status?.requestObserver.enabled ? `启用 · ${status.requestObserver.retained} 条` : "关闭"} />
      <p className="settings-copy">OpenAI Secure Tunnel 属于 DevPilot Supervisor 的运行方式，不写进上游 DevSpace 配置；工具 Surface、允许目录、Skills、Subagents 等则直接写入上游 config.jsonc。</p>
      <p className="settings-copy mono">配置文件：{settings?.configPath ?? "—"}</p>
    </Panel>
  </div>;
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (value: boolean) => void }) {
  return <label className="toggle-row"><span>{label}</span><input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} /></label>;
}

function shortId(id: string): string {
  if (id.length <= 24) return id;
  return `${id.slice(0, 12)}…${id.slice(-8)}`;
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { headers: { accept: "application/json" }, cache: "no-store" });
  const text = await response.text();
  if (!response.ok) throw new Error(text || `${response.status}`);
  return JSON.parse(text) as T;
}

createRoot(document.getElementById("devpilot-root")!).render(<App />);
