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
    publicBaseUrl?: string;
    publicMcpUrl?: string;
    healthUrl?: string;
    ready?: boolean;
  };
  providers: Array<{ name: string; available: boolean; note?: string; reason?: string }>;
  requestObserver: { enabled: boolean; retained: number };
  diagnostics?: {
    requests: {
      generatedAt: string;
      windowMs: number;
      slowThresholdMs: number;
      verySlowThresholdMs: number;
      state: "quiet" | "healthy" | "busy" | "slow" | "error";
      receivedCount: number;
      completedCount: number;
      runningCount: number;
      failedCount: number;
      slowCount: number;
      verySlowCount: number;
      p95DurationMs?: number;
      maxDurationMs?: number;
      latestRequestAt?: string;
      latestCompletedAt?: string;
      oldestRunning?: {
        id: string;
        startedAt: string;
        toolName?: string;
        mcpMethod?: string;
        elapsedMs: number;
      };
    };
    tunnel: {
      checkedAt?: string;
      ready?: boolean;
      readySince?: string;
      lastTransitionAt?: string;
      transitionCount: number;
      recentTransitions: Array<{ at: string; ready: boolean }>;
    };
  };
  events: Array<{ at: string; level: "info" | "warn" | "error"; message: string }>;
}

interface SettingsResponse {
  configPath: string;
  restartRequired: boolean;
  effective: {
    host: string;
    port: number;
    allowedRoots: string[];
    permissionMode: "restricted" | "full";
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
    permissionMode: "restricted" | "full";
    toolMode: "codex" | "claude";
  };
}

interface UpdateCheckResponse {
  ok: boolean;
  current: { version: string; portable: boolean };
  channel: "stable" | "preview";
  available: boolean;
  latest?: {
    tag: string;
    version: string;
    releaseUrl: string;
    zip: { name: string; url: string };
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
  const [updateChannel, setUpdateChannel] = useState<"stable" | "preview">("stable");
  const [updateCheck, setUpdateCheck] = useState<UpdateCheckResponse>();
  const [updateChecking, setUpdateChecking] = useState(false);
  const [updateError, setUpdateError] = useState<string>();

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

  useEffect(() => {
    // One bounded release check on opening Control Center; manual checks remain available.
    void fetchJson<UpdateCheckResponse>("/devpilot/api/updates?channel=stable")
      .then(async (result) => {
        if (result.current.version.includes("-")) {
          const preview = await fetchJson<UpdateCheckResponse>("/devpilot/api/updates?channel=preview");
          setUpdateChannel("preview");
          setUpdateCheck(preview);
        } else {
          setUpdateCheck(result);
        }
      })
      .catch(() => undefined);
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

  const checkUpdates = async () => {
    setUpdateChecking(true);
    setUpdateError(undefined);
    try {
      const next = await fetchJson<UpdateCheckResponse>(`/devpilot/api/updates?channel=${updateChannel}`);
      setUpdateCheck(next);
    } catch (reason) {
      setUpdateError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setUpdateChecking(false);
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
  const requestDiagnostics = status?.diagnostics?.requests;
  const tunnelDiagnostics = status?.diagnostics?.tunnel;

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
              <Metric label="Tunnel" value={status?.tunnel.ready ? "READY" : status?.tunnel.state ?? "—"} detail={status?.tunnel.tunnelId ?? status?.tunnel.publicMcpUrl ?? status?.tunnel.provider ?? "未配置"} />
              <Metric label="已识别对话" value={conversations.length} detail="按 openai/session 分组" />
              <Metric label="工具调用" value={toolCalls.length} detail={`保留请求 ${status?.requestObserver.retained ?? 0}`} />
              <Metric label="本地请求状态" value={requestStateLabel(requestDiagnostics?.state)} detail={`最近 5 分钟 ${requestDiagnostics?.receivedCount ?? 0} 个 MCP 请求`} />
              <Metric label="慢调用" value={requestDiagnostics?.slowCount ?? 0} detail={`≥ ${formatDuration(requestDiagnostics?.slowThresholdMs)}`} />
              <Metric label="本地 P95" value={formatDuration(requestDiagnostics?.p95DurationMs)} detail={`最大 ${formatDuration(requestDiagnostics?.maxDurationMs)}`} />
              <Metric label="Tunnel 连续 READY" value={status?.tunnel.ready ? formatSince(tunnelDiagnostics?.readySince, updatedAt) : "—"} detail={`状态变化 ${tunnelDiagnostics?.transitionCount ?? 0} 次`} />
            </section>

            <section className="diagnostic-grid">
              <Panel title="连接诊断" subtitle="区分 OpenAI / Secure Tunnel / 本地 MCP / 工具执行耗时">
                <div className={`diagnostic-verdict ${requestDiagnostics?.state ?? "quiet"}`}>
                  <strong>{diagnosticVerdict(requestDiagnostics, status?.tunnel.ready)}</strong>
                  <span>{diagnosticExplanation(requestDiagnostics, status?.tunnel.ready)}</span>
                </div>
                <div className="diagnostic-lines">
                  <InfoRow label="最近 MCP 到达" value={formatTimestampAge(requestDiagnostics?.latestRequestAt, updatedAt)} />
                  <InfoRow label="正在执行" value={String(requestDiagnostics?.runningCount ?? 0)} />
                  <InfoRow label="失败请求" value={String(requestDiagnostics?.failedCount ?? 0)} />
                  <InfoRow label="极慢调用" value={`${requestDiagnostics?.verySlowCount ?? 0} · ≥ ${formatDuration(requestDiagnostics?.verySlowThresholdMs)}`} />
                  <InfoRow label="最老运行任务" value={requestDiagnostics?.oldestRunning ? `${requestDiagnostics.oldestRunning.toolName ?? requestDiagnostics.oldestRunning.mcpMethod ?? "MCP"} · ${formatDuration(requestDiagnostics.oldestRunning.elapsedMs)}` : "无"} />
                  <InfoRow label="Tunnel 最近检测" value={formatTimestampAge(tunnelDiagnostics?.checkedAt, updatedAt)} />
                  <InfoRow label="Tunnel 最近变化" value={tunnelDiagnostics?.lastTransitionAt ? formatTimestampAge(tunnelDiagnostics.lastTransitionAt, updatedAt) : "本次运行未观察到变化"} />
                </div>
                <p className="diagnostic-help">ChatGPT 正在转圈时，如果“最近 MCP 到达”没有更新，请优先检查 OpenAI Connector、Secure Tunnel 与代理链路；如果请求已经到达且“最老运行任务”持续增长，耗时发生在本地工具执行。</p>
              </Panel>
            </section>

            <section className="diagnostic-grid">
              <Panel title="版本与更新" subtitle="GitHub Releases · 只检查公开版本，不会擅自重启或修改当前实例">
                <div className="update-strip">
                  <div>
                    <strong>DevPilot 版本</strong>
                    <p>{updateCheck ? `${updateCheck.current.version} · ${updateCheck.current.portable ? "便携安装" : "源码安装"}` : "点击检查获取本地版本及 GitHub 发行信息"}</p>
                  </div>
                  <div className="update-actions">
                    <select aria-label="更新频道" value={updateChannel} onChange={(event) => { setUpdateChannel(event.target.value as "stable" | "preview"); setUpdateCheck(undefined); }}>
                      <option value="stable">稳定版</option>
                      <option value="preview">包括预览版</option>
                    </select>
                    <button className="runtime-button" disabled={updateChecking} onClick={() => void checkUpdates()}>{updateChecking ? "检查中…" : "检查更新"}</button>
                  </div>
                </div>
                {updateError && <p className="update-note">检查失败：{updateError}</p>}
                {updateCheck && (
                  <div className="update-result">
                    {updateCheck.latest
                      ? <span>{updateCheck.available ? "发现新版本" : "当前没有更高版本"} · {updateCheck.latest.tag}</span>
                      : <span>此频道尚未发布带 Windows ZIP 和 SHA256 的正式 Release。</span>}
                    {updateCheck.available && updateCheck.latest && (
                      <a href={updateCheck.latest.releaseUrl} target="_blank" rel="noopener noreferrer">查看发行说明与下载包 ↗</a>
                    )}
                  </div>
                )}
                <p className="diagnostic-help">Windows 便携版可在退出 DevPilot 后双击「更新-DevPilot.cmd」，自动下载、校验 SHA256 并保留回滚备份。源码版请使用 Git 安全升级，勿直接用 ZIP 覆盖。</p>
              </Panel>
            </section>

            <section className="system-grid">
              <Panel title="连接与工具" subtitle="当前真实运行的 upstream DevSpace surface">
                <InfoRow label="架构" value={status?.architecture ?? "—"} />
                <InfoRow label="工具模式" value={status?.server.toolMode ?? "—"} />
                <InfoRow label="MCP PID" value={String(status?.server.pid ?? "—")} />
                <InfoRow label="本地 MCP" value={status?.server.localMcpUrl ?? "—"} mono />
                <InfoRow label="Tunnel" value={status?.tunnel.ready ? "READY" : status?.tunnel.state ?? "—"} />
                <InfoRow label="Tunnel 模式" value={status?.tunnel.provider ?? "—"} />
                <InfoRow label="公网 MCP" value={status?.tunnel.publicMcpUrl ?? "—"} mono />
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
    <tr key={request.id} className={`${selectedId === request.id ? "selected-row " : ""}${requestClass(request)}`} onClick={() => onSelect(request)}>
      <td>{new Date(request.startedAt).toLocaleTimeString()}</td><td>{request.mcpMethod ?? request.method}</td><td><code>{request.toolName ?? "—"}</code></td><td>{request.status ?? "运行中"}</td><td>{request.durationMs !== undefined ? formatDuration(request.durationMs) : formatDuration(Math.max(0, Date.now() - Date.parse(request.startedAt)))}</td>
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
  const [permissionMode, setPermissionMode] = useState<"restricted" | "full">("restricted");
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
    setPermissionMode(settings.effective.permissionMode);
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
    const enablingFull = permissionMode === "full" && settings?.effective.permissionMode !== "full";
    if (enablingFull && !window.confirm("完全权限模式将允许已连接的 MCP 客户端以你的 Windows 用户身份访问所有可访问文件夹，包括桌面和其他磁盘。继续开启？")) return;
    setMessage("正在保存…");
    try {
      const response = await fetch("/devpilot/api/settings", {
        method: "POST",
        headers: { "content-type": "application/json", "x-devpilot-control": "1" },
        body: JSON.stringify({
          host,
          port: Number(port),
          allowedRoots: roots.split(/\r?\n|,/).map((item) => item.trim()).filter(Boolean),
          permissionMode,
          ...(enablingFull ? { confirmFullAccess: "ENABLE FULL ACCESS" } : {}),
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
      <label className="form-row"><span>工具 Surface</span><select value={toolMode} onChange={(event) => setToolMode(event.target.value as "codex" | "claude")}><option value="codex">Codex：apply_patch + exec_command + write_stdin + workspace_turn</option><option value="claude">Claude：write + edit + bash</option></select></label>
      <label className="form-row"><span>本机文件权限</span><select value={permissionMode} onChange={(event) => setPermissionMode(event.target.value as "restricted" | "full")}><option value="restricted">受限模式（只允许指定目录）</option><option value="full">完全权限模式（允许此账户可访问的全部路径）</option></select></label>
      {permissionMode === "full" && <p className="settings-copy">⚠ 完全权限模式会扩大所有已授权 MCP 客户端可打开的工作区范围。此模式不授予 Windows 管理员权限，也不绕过操作系统及平台的安全检查；推荐只在可信账号和私有连接下开启。</p>}
      <label className="form-row vertical"><span>允许目录（受限模式生效，切换回受限后恢复使用）</span><textarea rows={5} value={roots} onChange={(event) => setRoots(event.target.value)} /></label>
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
      <InfoRow label="当前本机权限" value={settings?.runtime.permissionMode === "full" ? "完全权限" : "受限目录"} />
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

type RequestDiagnostics = NonNullable<StatusResponse["diagnostics"]>["requests"];

function requestStateLabel(state: RequestDiagnostics["state"] | undefined): string {
  if (state === "healthy") return "正常";
  if (state === "busy") return "执行中";
  if (state === "slow") return "本地较慢";
  if (state === "error") return "有失败";
  return "安静";
}

function diagnosticVerdict(requests: RequestDiagnostics | undefined, tunnelReady: boolean | undefined): string {
  if (tunnelReady === false) return "Secure Tunnel 当前未 READY";
  if (requests?.state === "error") return "最近请求已经到达本机，但存在本地失败";
  if (requests?.state === "slow") return "最近请求已经到达本机，本地执行存在明显慢调用";
  if (requests?.state === "busy") return "请求已经到达本机，工具仍在执行";
  if (requests?.state === "healthy") return "最近 MCP 请求在本地正常完成";
  return "本地最近没有收到 MCP 请求";
}

function diagnosticExplanation(requests: RequestDiagnostics | undefined, tunnelReady: boolean | undefined): string {
  if (tunnelReady === false) return "优先检查 Secure Tunnel、OpenAI 控制面和本地代理连接。";
  if (!requests || requests.state === "quiet") return "如果此时 ChatGPT 正在等待，延迟发生在请求抵达本地 MCP 之前。";
  if (requests.state === "slow" || requests.state === "busy") return "本地 Request Observer 已经看到请求，可继续根据工具名和运行时间定位耗时。";
  if (requests.state === "error") return "请求已经进入 DevPilot，请查看请求观察器中的 HTTP 状态和工具详情。";
  return "本地链路当前没有明显异常。";
}

function requestClass(request: ObservedRequest): string {
  if (request.status !== undefined && request.status >= 400) return "request-error";
  const elapsed = request.durationMs ?? Math.max(0, Date.now() - Date.parse(request.startedAt));
  if (elapsed >= 15_000) return "request-very-slow";
  if (elapsed >= 5_000) return "request-slow";
  return "";
}

function formatDuration(value: number | undefined): string {
  if (value === undefined) return "—";
  if (value < 1_000) return `${Math.round(value)} ms`;
  if (value < 60_000) return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)} s`;
  return `${Math.floor(value / 60_000)}m ${Math.round((value % 60_000) / 1_000)}s`;
}

function formatTimestampAge(value: string | undefined, now: Date | undefined): string {
  if (!value) return "未观察到";
  const age = Math.max(0, (now?.getTime() ?? Date.now()) - Date.parse(value));
  return `${new Date(value).toLocaleTimeString()} · ${formatDuration(age)} 前`;
}

function formatSince(value: string | undefined, now: Date | undefined): string {
  if (!value) return "—";
  return formatDuration(Math.max(0, (now?.getTime() ?? Date.now()) - Date.parse(value)));
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { headers: { accept: "application/json" }, cache: "no-store" });
  const text = await response.text();
  if (!response.ok) throw new Error(text || `${response.status}`);
  return JSON.parse(text) as T;
}

createRoot(document.getElementById("devpilot-root")!).render(<App />);
