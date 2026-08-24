import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import "./control-center.css";

type View = "overview" | "requests" | "settings";

interface StatusResponse {
  product: string;
  server: {
    status: string;
    authMode?: "oauth" | "secure-tunnel";
    toolMode: string;
    host: string;
    port: number;
    localMcpUrl: string;
    publicMcpUrl: string;
    publicEndpointConfigured: boolean;
  };
  tunnel?: { provider: string; tunnelId?: string; ready?: boolean; healthUrl?: string };
  daemon: { available: boolean; state: string; reason?: string };
  providers: Array<{ name: string; available: boolean; note?: string; reason?: string }>;
  requestObserver?: { enabled: boolean; retained: number };
}

interface SettingsResponse {
  configPath: string;
  effective: {
    host: string;
    port: number;
    allowedRoots: string[];
    authMode?: "oauth" | "secure-tunnel";
    toolMode: "minimal" | "full" | "codex";
    widgets: "off" | "changes" | "full";
    publicBaseUrl: string;
  };
  saved: Record<string, unknown>;
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
  responsePreview?: string;
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
  const [requests, setRequests] = useState<ObservedRequest[]>([]);
  const [conversations, setConversations] = useState<ObservedConversation[]>([]);
  const [settings, setSettings] = useState<SettingsResponse | null>(null);
  const [selectedConversationId, setSelectedConversationId] = useState<string>();
  const [selected, setSelected] = useState<ObservedRequest | null>(null);
  const [error, setError] = useState<string>();
  const [updatedAt, setUpdatedAt] = useState<Date>();

  const refresh = async () => {
    try {
      const [nextStatus, nextRequests, nextConversations, nextSettings] = await Promise.all([
        fetchJson<StatusResponse>("/devpilot/api/status"),
        fetchJson<{ requests: ObservedRequest[] }>("/devpilot/api/requests?limit=200"),
        fetchJson<{ conversations: ObservedConversation[] }>("/devpilot/api/conversations"),
        fetchJson<SettingsResponse>("/devpilot/api/settings"),
      ]);
      setStatus(nextStatus);
      setRequests(nextRequests.requests);
      setConversations(nextConversations.conversations);
      setSettings(nextSettings);
      setUpdatedAt(new Date());
      setError(undefined);
      if (selected) {
        const current = nextRequests.requests.find((item) => item.id === selected.id);
        if (current) setSelected(current);
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

  const mcpRequests = useMemo(() => requests.filter((item) => item.path === "/mcp"), [requests]);
  const toolCalls = useMemo(() => mcpRequests.filter((item) => item.toolName), [mcpRequests]);
  const conversationRequests = useMemo(
    () => selectedConversationId
      ? mcpRequests.filter((item) => item.conversationScopeId === selectedConversationId)
      : mcpRequests,
    [mcpRequests, selectedConversationId],
  );
  const unidentifiedCount = useMemo(() => mcpRequests.filter((item) => !item.conversationScopeId).length, [mcpRequests]);
  const running = requests.filter((item) => item.status === undefined).length;
  const availableProviders = status?.providers.filter((item) => item.available).length ?? 0;

  return (
    <div className="dp-shell">
      <aside className="dp-sidebar">
        <div className="brand">
          <div className="brand-mark">DP</div>
          <div><strong>DevPilot</strong><span>DevSpace 控制中心</span></div>
        </div>
        <nav className="nav">
          <NavButton label="总览" active={view === "overview"} onClick={() => setView("overview")} />
          <NavButton label="请求观察器" badge={running || undefined} active={view === "requests"} onClick={() => setView("requests")} />
          <NavButton label="设置" active={view === "settings"} onClick={() => setView("settings")} />
        </nav>
        <div className="sidebar-footer">
          <div className="connection-row"><span className={`status-dot ${status?.server.status === "online" ? "ok" : "off"}`} />本机管理界面</div>
          <small>{updatedAt ? `更新于 ${updatedAt.toLocaleTimeString()}` : "正在连接…"}</small>
        </div>
      </aside>

      <main className="dp-main">
        <header className="topbar">
          <div><p className="eyebrow">DEVSPACE</p><h1>{view === "overview" ? "总览" : view === "requests" ? "ChatGPT 请求观察器" : "设置"}</h1></div>
          <button className="refresh-button" onClick={() => void refresh()}>刷新</button>
        </header>
        {error && <div className="error-banner">{error}</div>}

        {view === "overview" && (
          <div className="view-stack">
            <section className="metric-grid">
              <Metric label="DevSpace" value={status?.server.status === "online" ? "在线" : "离线"} detail={status?.server.localMcpUrl ?? "—"} />
              <Metric label="已识别对话" value={conversations.length} detail="按 openai/session 隔离" />
              <Metric label="已观察请求" value={mcpRequests.length} detail="当前内存记录" />
              <Metric label="工具调用" value={toolCalls.length} detail="来自 MCP tools/call" />
              <Metric label="可用 Provider" value={availableProviders} detail={`${status?.providers.length ?? 0} 个已检测`} />
            </section>
            <section className="system-grid">
              <Panel title="连接状态" subtitle="DevSpace 与 ChatGPT/MCP 的当前连接信息">
                <InfoRow label="MCP 状态" value={status?.server.status === "online" ? "在线" : "离线"} />
                <InfoRow label="认证模式" value={status?.server.authMode === "secure-tunnel" ? "OpenAI Secure Tunnel" : "OAuth"} />
                <InfoRow label="工具模式" value={status?.server.toolMode ?? "—"} />
                <InfoRow label="本地 MCP" value={status?.server.localMcpUrl ?? "—"} mono />
                {status?.server.authMode === "secure-tunnel" ? <>
                  <InfoRow label="OpenAI Tunnel" value={status?.tunnel?.ready ? "已连接" : "未就绪"} />
                  <InfoRow label="Tunnel ID" value={status?.tunnel?.tunnelId ?? "—"} mono />
                </> : <InfoRow label="公网 MCP" value={status?.server.publicMcpUrl ?? "—"} mono />}
              </Panel>
              <Panel title="Provider" subtitle="本机检测到的执行后端">
                {(status?.providers ?? []).map((provider) => (
                  <div className="provider-row" key={provider.name}>
                    <span className={`status-dot ${provider.available ? "ok" : "off"}`} />
                    <div><strong>{provider.name}</strong><span>{provider.note ?? provider.reason ?? (provider.available ? "可用" : "不可用")}</span></div>
                  </div>
                ))}
              </Panel>
            </section>
            <Panel title="最近请求" subtitle="ChatGPT 或其他 MCP Host 发到 DevSpace 的请求">
              <RequestTable requests={mcpRequests.slice(0, 10)} onSelect={(item) => { setSelected(item); setView("requests"); }} />
            </Panel>
          </div>
        )}

        {view === "requests" && (
          <div className="conversation-request-layout">
            <section className="conversation-list-panel">
              <div className="section-heading"><div><h2>ChatGPT 对话</h2><p>按 openai/session 隔离显示。</p></div><span className="count-chip">{conversations.length}</span></div>
              <ConversationList
                conversations={conversations}
                selectedId={selectedConversationId}
                unidentifiedCount={unidentifiedCount}
                onSelect={(id) => {
                  setSelectedConversationId(id);
                  setSelected(null);
                }}
              />
            </section>
            <section className="request-list-panel">
              <div className="section-heading"><div><h2>{selectedConversationId ? "当前对话请求" : "全部请求"}</h2><p>{selectedConversationId ? shortConversationId(selectedConversationId) : "实时显示全部 MCP 请求与工具调用。"}</p></div><span className="count-chip">{conversationRequests.length}</span></div>
              <RequestTable requests={conversationRequests} onSelect={setSelected} selectedId={selected?.id} />
            </section>
            <section className="request-detail-panel">
              {selected ? <RequestDetail request={selected} /> : <div className="empty-state padded">选择一条请求查看详细信息</div>}
            </section>
          </div>
        )}

        {view === "settings" && (
          <SettingsView settings={settings} status={status} onSaved={() => void refresh()} />
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
  return <div className="conversation-list">
    <button className={`conversation-item ${selectedId === undefined ? "active" : ""}`} onClick={() => onSelect(undefined)}>
      <div><strong>全部对话</strong><span>所有 MCP 请求</span></div><em>{conversations.reduce((sum, item) => sum + item.requestCount, 0) + unidentifiedCount}</em>
    </button>
    {conversations.map((conversation) => (
      <button key={conversation.id} className={`conversation-item ${selectedId === conversation.id ? "active" : ""}`} onClick={() => onSelect(conversation.id)}>
        <div><strong>{shortConversationId(conversation.id)}</strong><span>{conversation.lastToolName ? `最近：${conversation.lastToolName}` : "已识别 ChatGPT 对话"}</span></div>
        <div className="conversation-meta"><em>{conversation.toolCallCount}</em><span>{new Date(conversation.lastSeenAt).toLocaleTimeString()}</span></div>
      </button>
    ))}
    {unidentifiedCount > 0 && <div className="conversation-item unidentified"><div><strong>未识别会话</strong><span>初始化、探活或没有 openai/session 的请求</span></div><em>{unidentifiedCount}</em></div>}
  </div>;
}

function RequestTable({ requests, onSelect, selectedId }: { requests: ObservedRequest[]; onSelect: (request: ObservedRequest) => void; selectedId?: string }) {
  if (!requests.length) return <div className="empty-state padded">还没有观察到 MCP 请求。打开 ChatGPT 调用一次 DevSpace 后，这里会实时出现。</div>;
  return <div className="table-wrap"><table><thead><tr><th>时间</th><th>类型</th><th>工具</th><th>状态</th><th>耗时</th></tr></thead><tbody>{requests.map((request) => <tr key={request.id} className={selectedId === request.id ? "selected-row" : ""} onClick={() => onSelect(request)}><td>{new Date(request.startedAt).toLocaleTimeString()}</td><td>{request.mcpMethod ?? request.method}</td><td><code>{request.toolName ?? "—"}</code></td><td>{request.status ?? "运行中"}</td><td>{request.durationMs !== undefined ? `${request.durationMs} ms` : "—"}</td></tr>)}</tbody></table></div>;
}

function RequestDetail({ request }: { request: ObservedRequest }) {
  return <div className="request-detail"><div className="detail-header"><div><p className="eyebrow">MCP REQUEST</p><h2>{request.toolName ?? request.mcpMethod ?? request.path}</h2></div><span className={`status-badge ${request.status && request.status < 400 ? "completed" : request.status ? "failed" : "running"}`}>{request.status ?? "运行中"}</span></div><div className="detail-grid"><Detail label="ChatGPT 对话" value={request.conversationScopeId ? shortConversationId(request.conversationScopeId) : "未识别"} /><Detail label="请求 ID" value={request.id} /><Detail label="开始时间" value={new Date(request.startedAt).toLocaleString()} /><Detail label="HTTP" value={`${request.method} ${request.path}`} /><Detail label="耗时" value={request.durationMs !== undefined ? `${request.durationMs} ms` : "—"} /><Detail label="MCP 方法" value={request.mcpMethod ?? "—"} /><Detail label="工具" value={request.toolName ?? "—"} /><Detail label="MCP Session" value={request.mcpSessionId ? shortConversationId(request.mcpSessionId) : "—"} /></div><div className="result-box"><span>完整对话 ID</span><pre>{request.conversationScopeId ?? "未提供 openai/session"}</pre></div><div className="result-box"><span>参数摘要</span><pre>{request.paramsPreview ?? "无参数"}</pre></div><div className="result-box"><span>User-Agent</span><pre>{request.userAgent ?? "—"}</pre></div></div>;
}

function shortConversationId(id: string): string {
  if (id.length <= 24) return id;
  return `${id.slice(0, 12)}…${id.slice(-8)}`;
}

function Detail({ label, value }: { label: string; value: string }) {
  return <div className="detail-item"><span>{label}</span><strong>{value}</strong></div>;
}

function SettingsView({ settings, status, onSaved }: { settings: SettingsResponse | null; status: StatusResponse | null; onSaved: () => void }) {
  const [host, setHost] = useState(settings?.effective.host ?? "127.0.0.1");
  const [port, setPort] = useState(String(settings?.effective.port ?? 7681));
  const [roots, setRoots] = useState((settings?.effective.allowedRoots ?? []).join("\n"));
  const [authMode, setAuthMode] = useState<"oauth" | "secure-tunnel">(settings?.effective.authMode ?? "oauth");
  const [toolMode, setToolMode] = useState<"minimal" | "full" | "codex">(settings?.effective.toolMode ?? "full");
  const [widgets, setWidgets] = useState<"off" | "changes" | "full">(settings?.effective.widgets ?? "changes");
  const [publicBaseUrl, setPublicBaseUrl] = useState(settings?.effective.publicBaseUrl ?? "");
  const [message, setMessage] = useState<string>();

  useEffect(() => {
    if (!settings) return;
    setHost(settings.effective.host);
    setPort(String(settings.effective.port));
    setRoots(settings.effective.allowedRoots.join("\n"));
    setAuthMode(settings.effective.authMode ?? "oauth");
    setToolMode(settings.effective.toolMode);
    setWidgets(settings.effective.widgets);
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
          authMode,
          toolMode,
          widgets,
          publicBaseUrl,
        }),
      });
      if (!response.ok) throw new Error(await response.text());
      setMessage("已保存。重启 DevSpace 后生效。");
      onSaved();
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : String(reason));
    }
  };

  return <div className="settings-grid">
    <Panel title="DevSpace 设置" subtitle="修改后写入 ~/.devspace/config.json，重启 DevSpace 生效。">
      <label className="form-row"><span>监听地址</span><input value={host} onChange={(e) => setHost(e.target.value)} /></label>
      <label className="form-row"><span>端口</span><input value={port} onChange={(e) => setPort(e.target.value)} inputMode="numeric" /></label>
      <label className="form-row"><span>认证模式</span><select value={authMode} onChange={(e) => setAuthMode(e.target.value as typeof authMode)}><option value="secure-tunnel">OpenAI Secure Tunnel</option><option value="oauth">OAuth（公网 MCP）</option></select></label>
      <label className="form-row"><span>工具模式</span><select value={toolMode} onChange={(e) => setToolMode(e.target.value as typeof toolMode)}><option value="minimal">minimal</option><option value="full">full</option><option value="codex">codex</option></select></label>
      <label className="form-row"><span>ChatGPT 工具 UI</span><select value={widgets} onChange={(e) => setWidgets(e.target.value as typeof widgets)}><option value="off">关闭 widgets</option><option value="changes">只显示变更汇总</option><option value="full">完整 widgets</option></select></label>
      <label className="form-row vertical"><span>允许目录</span><textarea value={roots} onChange={(e) => setRoots(e.target.value)} rows={4} /></label>
      <label className="form-row vertical"><span>公网 MCP 地址（仅 OAuth 模式）</span><input value={publicBaseUrl} disabled={authMode === "secure-tunnel"} onChange={(e) => setPublicBaseUrl(e.target.value)} /></label>
      <div className="settings-actions"><button className="refresh-button" onClick={() => void save()}>保存设置</button><span>{message ?? ""}</span></div>
    </Panel>
    <Panel title="工具调用降噪" subtitle="能控制的是 DevSpace 自己提供给 ChatGPT 的 UI，不是 ChatGPT 客户端本身。">
      <InfoRow label="当前 widgets" value={settings?.effective.widgets ?? "—"} />
      <InfoRow label="请求观察器" value={status?.requestObserver?.enabled ? "已启用" : "未启用"} />
      <InfoRow label="已保留请求" value={String(status?.requestObserver?.retained ?? 0)} />
      <p className="settings-copy">把“ChatGPT 工具 UI”设为“关闭 widgets”后，DevSpace 不再主动返回自己的 MCP App/Widget 展示；ChatGPT 自带的基础工具调用状态仍由 ChatGPT 客户端控制，服务端无法强制隐藏。请求详情会继续在本地 DevPilot 里完整保留。</p>
      <p className="settings-copy mono">配置文件：{settings?.configPath ?? "—"}</p>
    </Panel>
  </div>;
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { headers: { accept: "application/json" } });
  const text = await response.text();
  if (!response.ok) throw new Error(text || `${response.status}`);
  return JSON.parse(text) as T;
}

createRoot(document.getElementById("devpilot-root")!).render(<App />);
