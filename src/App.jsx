import { useCallback, useEffect, useMemo, useState } from "react";

async function api(path, options = {}) {
  const response = await fetch(path, { credentials: "same-origin", ...options });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = body.error?.message ?? "网络请求失败，请稍后重试";
    throw Object.assign(new Error(message), { status: response.status, body });
  }
  return body;
}

function dateKey(date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function atTime(date, time) {
  return new Date(`${date}T${time}:00+08:00`).getTime();
}

function getProgram(room, timestamp) {
  if (!room) return { current: null, next: null, display: null, today: [], nextChangeAt: null };
  const today = dateKey(new Date(timestamp));
  const yesterdayDate = new Date(`${today}T00:00:00+08:00`);
  yesterdayDate.setUTCDate(yesterdayDate.getUTCDate() - 1);
  const yesterday = dateKey(yesterdayDate);
  const sessions = (room.schedule ?? [])
    .filter((item) => item.date === today || item.date === yesterday)
    .map((item) => {
      const startAt = Number(item.startsAt) || atTime(item.date, item.start);
      let endAt = Number(item.endsAt) || atTime(item.date, item.end);
      if (endAt <= startAt) endAt += 24 * 60 * 60 * 1000;
      return { ...item, startAt, endAt };
    })
    .sort((a, b) => a.startAt - b.startAt);

  const current = sessions.find((item) => item.startAt <= timestamp && timestamp < item.endAt) ?? null;
  const next = sessions.find((item) => item.startAt > timestamp) ?? null;
  const nextChangeAt = current
    ? Math.min(current.endAt, next?.startAt ?? current.endAt)
    : next?.startAt ?? null;
  return {
    current, next, display: current ?? next,
    today: (room.schedule ?? []).filter((item) => item.date === today),
    nextChangeAt,
  };
}

function formatRange(item) {
  if (!item) return "—";
  return `${item.start}–${item.end}`;
}

function formatDate(date) {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "long", day: "numeric", weekday: "long",
  }).format(date);
}

function formatClock(date) {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }).format(date);
}

function RoleCard({ label, value, featured = false }) {
  return (
    <section className={`role-card${featured ? " role-card-featured" : ""}`}>
      <div className="role-label">{label}</div>
      <div className="role-name">{value || "待安排"}</div>
    </section>
  );
}

function MerchandisingInfo({ products = [], salesTarget = "" }) {
  const items = Array.isArray(products) ? products.filter(Boolean) : [];
  return (
    <div className="merch-row">
      <section className="merch-card products-card" aria-label="主推商品">
        <div className="merch-heading">
          <div><span className="merch-kicker">FEATURED</span><h2>主推商品</h2></div>
          <span className="product-count">{items.length} 款</span>
        </div>
        {items.length ? (
          <ol className="product-list">
            {items.map((product, index) => (
              <li key={`${product}-${index}`}>
                <span className="product-index">{String(index + 1).padStart(2, "0")}</span>
                <span className="product-name">{product}</span>
              </li>
            ))}
          </ol>
        ) : <div className="merch-empty">暂未配置主推商品</div>}
      </section>
      <section className="merch-card target-card" aria-label="目标销售额">
        <span className="merch-kicker">SALES TARGET</span>
        <span className="target-label">目标销售额</span>
        <strong className="target-value">{salesTarget || "待设置"}</strong>
      </section>
    </div>
  );
}

function Brand({ compact = false }) {
  return (
    <div className="brand-lockup">
      <div className="brand-mark" aria-hidden="true">L</div>
      <div>
        <div className="brand-kicker">STUDIO DISPLAY</div>
        <div className="brand-title">直播间信息牌{compact ? " · 管理端" : ""}</div>
      </div>
    </div>
  );
}

function AuthHeader() {
  return <header className="auth-brand"><Brand /></header>;
}

function LoginPage({ onLogin }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(event) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setMessage("");
    try {
      await onLogin(username.trim(), password);
    } catch (cause) {
      setMessage(cause.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="auth-shell">
      <AuthHeader />
      <main className="auth-card">
        <div className="section-kicker">WELCOME BACK</div>
        <h1>登录工作台</h1>
        <p className="auth-intro">使用已分配的账号进入直播间信息展示系统。</p>
        <form className="auth-form" onSubmit={submit}>
          <label htmlFor="username">账号</label>
          <input id="username" autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value)} required />
          <label htmlFor="password">密码</label>
          <input id="password" type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required />
          {message && <div className="form-message form-error" role="alert">{message}</div>}
          <button className="button-primary auth-submit" type="submit" disabled={busy}>{busy ? "正在登录…" : "登录"}</button>
        </form>
        <div className="auth-footnote"><span className="secure-dot" /> 账号由管理员统一配置</div>
      </main>
      <div className="auth-caption">LIVE ROOM OPERATIONS · SECURE DISPLAY</div>
    </div>
  );
}

function AdminPage({ user, csrfToken, onLogout }) {
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [message, setMessage] = useState("");
  async function upload(event) {
    event.preventDefault();
    if (!file || busy) return;
    setBusy(true);
    setMessage("");
    setResult(null);
    const form = new FormData();
    form.append("file", file);
    try {
      const response = await fetch("/api/v1/admin/schedule-upload", {
        method: "POST", credentials: "same-origin", headers: { "x-csrf-token": csrfToken }, body: form,
      });
      const body = await response.json();
      setResult(body);
      if (response.ok) setMessage("工作簿已更新，展示页将在 30 秒内同步新排班。");
      else if (body.error) setMessage(body.error.message);
      else setMessage(`发现 ${body.errors?.length ?? 0} 项需要修正，现有数据未更改。`);
    } catch {
      setMessage("上传未完成，请检查网络连接后重试。现有数据保持不变。");
    } finally {
      setBusy(false);
    }
  }
  const problems = result?.errors ?? [];
  const warnings = result?.warnings ?? [];
  return (
    <div className="admin-shell">
      <header className="topbar admin-topbar">
        <Brand compact />
        <div className="admin-account">
          <span className="account-avatar">{user.username.slice(0, 1).toUpperCase()}</span>
          <span>{user.username}<small>管理员</small></span>
          <button className="topbar-action" type="button" onClick={onLogout}>退出</button>
        </div>
      </header>
      <main className="admin-workspace">
        <section className="admin-hero">
          <div className="section-kicker">DATA MANAGEMENT</div>
          <h1>排班信息管理</h1>
          <p>每个工作表对应一个直播间。上传完整工作簿后，系统会先校验所有工作表，再一次性更新展示数据。</p>
        </section>
        <section className="admin-card">
          <div className="admin-card-heading">
            <div className="admin-icon">↥</div>
            <div><h2>导入直播间排班</h2><p>支持 Excel 工作簿（.xlsx）和嵌入式 JPG、PNG 主播照片</p></div>
          </div>
          <form className="upload-form" onSubmit={upload}>
            <label className={`upload-dropzone${file ? " upload-selected" : ""}`} htmlFor="workbook-file">
              <span className="upload-glyph">⌁</span>
              <strong>{file ? file.name : "选择排班工作簿"}</strong>
              <small>{file ? `${(file.size / 1024 / 1024).toFixed(2)} MB · 点击更换` : "点击选择 .xlsx 文件，文件最大 30 MB"}</small>
              <input id="workbook-file" type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={(event) => setFile(event.target.files?.[0] ?? null)} />
            </label>
            <button className="button-primary upload-button" type="submit" disabled={!file || busy}>{busy ? "正在校验并导入…" : "校验并更新排班"}</button>
          </form>
          {message && <div className={`form-message${problems.length ? " form-error" : result?.ok ? " form-success" : ""}`} role="status">{message}</div>}
          {result?.ok && <div className="import-summary"><span><strong>{result.roomCount}</strong> 个直播间</span><span><strong>{result.scheduleCount}</strong> 场排班</span><span>更新时间 <strong>{new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(result.dataUpdatedAt))}</strong></span></div>}
          {problems.length > 0 && <div className="issue-list"><h3>需要修正的内容 <span>{problems.length}</span></h3>{problems.map((issue, index) => <div className="issue-row" key={`${issue.sheet}-${issue.row}-${index}`}><span>{issue.sheet || "工作簿"}</span><span>{issue.row ? `第 ${issue.row} 行 · ` : ""}{issue.field}</span><strong>{issue.message}</strong></div>)}</div>}
          {warnings.length > 0 && <div className="warning-list"><h3>导入提示 <span>{warnings.length}</span></h3>{warnings.slice(0, 20).map((issue, index) => <div className="warning-row" key={`${issue.sheet}-${issue.row}-${index}`}>{issue.sheet} · 第 {issue.row} 行 · {issue.field}：{issue.message}</div>)}{warnings.length > 20 && <div className="warning-row">另有 {warnings.length - 20} 条提示。</div>}</div>}
        </section>
        <aside className="admin-note"><span>i</span><div><strong>更新规则</strong><p>工作簿任一直播间存在错误时，本次导入不会改变正在展示的数据。照片须放在对应排班行的 G 列单元格区域。</p></div></aside>
      </main>
      <footer className="admin-footer">直播间信息牌 <span>·</span> 管理工作台</footer>
    </div>
  );
}

export function App() {
  const [authLoading, setAuthLoading] = useState(true);
  const [user, setUser] = useState(null);
  const [csrfToken, setCsrfToken] = useState("");
  const [rooms, setRooms] = useState([]);
  const [roomId, setRoomId] = useState("");
  const [displayData, setDisplayData] = useState(null);
  const [serverOffset, setServerOffset] = useState(0);
  const [realTime, setRealTime] = useState(Date.now());
  const [connectionError, setConnectionError] = useState("");

  const loadRooms = useCallback(async () => {
    const response = await api("/api/v1/rooms");
    const mapped = response.rooms.map((room) => ({ id: room.code, name: room.name }));
    setRooms(mapped);
    setConnectionError("");
    setRoomId((selected) => {
      const remembered = selected || window.localStorage.getItem("live-room-selected") || "";
      return mapped.some((room) => room.id === remembered) ? remembered : (mapped[0]?.id ?? "");
    });
  }, []);

  const refreshDisplay = useCallback(async (code) => {
    if (!code) return;
    try {
      const response = await api(`/api/v1/rooms/${encodeURIComponent(code)}/display`);
      const receivedAt = Date.now();
      setDisplayData((current) => {
        if (current?.room?.id === response.room.code && current.dataUpdatedAt === response.dataUpdatedAt) {
          return { ...current, nextTransitionAt: response.nextTransitionAt };
        }
        return {
          room: { id: response.room.code, name: response.room.name },
          schedule: response.schedule,
          nextTransitionAt: response.nextTransitionAt,
          dataUpdatedAt: response.dataUpdatedAt,
        };
      });
      setServerOffset(new Date(response.serverNow).getTime() - receivedAt);
      setConnectionError("");
    } catch (cause) {
      if (cause.status === 401) {
        setUser(null);
        setDisplayData(null);
      } else if (cause.status === 404) {
        setDisplayData(null);
        loadRooms().catch(() => setConnectionError("正在同步直播间列表…"));
      } else {
        setConnectionError("连接暂时中断，正在尝试恢复；页面保留上次成功加载的信息。");
      }
    }
  }, [loadRooms]);

  useEffect(() => {
    let active = true;
    api("/api/v1/auth/me")
      .then((response) => {
        if (!active) return;
        setUser(response.user);
        setCsrfToken(response.csrfToken);
      })
      .catch(() => { if (active) setUser(null); })
      .finally(() => { if (active) setAuthLoading(false); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (user?.role !== "viewer") {
      setRooms([]);
      setDisplayData(null);
      return;
    }
    loadRooms().catch(() => setConnectionError("暂时无法读取直播间列表，请检查服务后刷新页面。"));
  }, [user, loadRooms]);

  useEffect(() => {
    if (user?.role !== "viewer") return undefined;
    const refreshRooms = () => loadRooms().catch(() => setConnectionError("暂时无法读取直播间列表，正在重试。"));
    const onReturn = () => { if (document.visibilityState === "visible") refreshRooms(); };
    const timer = window.setInterval(refreshRooms, 30_000);
    window.addEventListener("online", refreshRooms);
    document.addEventListener("visibilitychange", onReturn);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("online", refreshRooms);
      document.removeEventListener("visibilitychange", onReturn);
    };
  }, [user, loadRooms]);

  useEffect(() => {
    if (!roomId || user?.role !== "viewer") return undefined;
    refreshDisplay(roomId);
    const update = () => refreshDisplay(roomId);
    const poll = window.setInterval(update, 30_000);
    const onReturn = () => { if (document.visibilityState === "visible") update(); };
    window.addEventListener("online", update);
    document.addEventListener("visibilitychange", onReturn);
    return () => {
      window.clearInterval(poll);
      window.removeEventListener("online", update);
      document.removeEventListener("visibilitychange", onReturn);
    };
  }, [user, roomId, refreshDisplay]);

  useEffect(() => {
    if (!roomId || user?.role !== "viewer" || !displayData?.nextTransitionAt) return undefined;
    const boundaryDelay = Math.max(250, displayData.nextTransitionAt - (Date.now() + serverOffset) + 100);
    if (boundaryDelay >= 30_000) return undefined;
    const boundary = window.setTimeout(() => refreshDisplay(roomId), boundaryDelay);
    return () => window.clearTimeout(boundary);
  }, [user, roomId, displayData?.nextTransitionAt, serverOffset, refreshDisplay]);

  useEffect(() => {
    if (user?.role !== "viewer") return undefined;
    const timer = window.setInterval(() => setRealTime(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [user]);

  useEffect(() => {
    function updateFullscreenLayout() {
      const availableHeight = window.screen?.availHeight || window.screen?.height || 0;
      const isFullscreenViewport = window.innerWidth >= 1100 && availableHeight > 0 && window.innerHeight / availableHeight >= 0.94;
      document.documentElement.classList.toggle("fullscreen-layout", isFullscreenViewport);
    }
    updateFullscreenLayout();
    window.addEventListener("resize", updateFullscreenLayout);
    return () => {
      window.removeEventListener("resize", updateFullscreenLayout);
      document.documentElement.classList.remove("fullscreen-layout");
    };
  }, []);

  async function login(username, password) {
    const response = await api("/api/v1/auth/login", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username, password }),
    });
    setUser(response.user);
    setCsrfToken(response.csrfToken);
  }

  async function logout() {
    try { await api("/api/v1/auth/logout", { method: "POST", headers: { "x-csrf-token": csrfToken } }); } catch {}
    setUser(null);
    setRooms([]);
    setDisplayData(null);
    setCsrfToken("");
  }

  function chooseRoom(nextId) {
    setRoomId(nextId);
    setDisplayData(null);
    window.localStorage.setItem("live-room-selected", nextId);
  }

  const timestamp = realTime + serverOffset;
  const room = useMemo(() => {
    const selected = rooms.find((item) => item.id === roomId);
    if (!selected) return null;
    return { ...selected, schedule: displayData?.room?.id === roomId ? displayData.schedule : [] };
  }, [rooms, roomId, displayData]);
  const program = useMemo(() => getProgram(room, timestamp), [room, timestamp]);
  const displayed = program.display;
  const isLive = Boolean(program.current);
  const nowDate = new Date(timestamp);
  const statusText = isLive ? "当前直播" : displayed ? "下一场排班" : "暂无排班";

  if (authLoading) return <div className="system-loading"><div className="loading-orbit" /><span>正在连接展示系统</span></div>;
  if (!user) return <LoginPage onLogin={login} />;
  if (user.role === "admin") return <AdminPage user={user} csrfToken={csrfToken} onLogout={logout} />;

  return (
    <div className="app-shell">
      <header className="topbar">
        <Brand />
        <div className="room-selector-inline">
          <label htmlFor="room-select">直播间</label>
          <select id="room-select" value={roomId} onChange={(event) => chooseRoom(event.target.value)} disabled={!rooms.length}>
            {rooms.map((item) => <option key={item.id} value={item.id}>{item.id}号直播间 · {item.name}</option>)}
          </select>
        </div>
        <div className="topbar-right">
          <span className="refresh-indicator" />
          <span>{connectionError ? "正在重连" : "实时同步"}</span>
          <span className="topbar-divider" />
          <span className="viewer-account">{user.username}</span>
          <button className="topbar-action" type="button" onClick={logout}>退出</button>
        </div>
      </header>

      {connectionError && <div className="connection-banner" role="status">{connectionError}</div>}
      <main className="workspace">
        <aside className="control-column">
          <section className="control-card clock-card">
            <div className="section-heading">
              <div><div className="section-kicker">SHANGHAI TIME</div><h2>现场时钟</h2></div>
              <span className="mode-pill mode-live">实时</span>
            </div>
            <div className="clock-current">{formatClock(nowDate)}</div>
            <div className="clock-date">{formatDate(nowDate)}</div>
          </section>

          <section className="control-card schedule-card">
            <div className="section-heading schedule-heading">
              <div><div className="section-kicker">TODAY</div><h2>当日排班</h2></div>
              <span className="schedule-count">{program.today.length} 场</span>
            </div>
            {program.today.length ? (
              <ol className="schedule-list">
                {program.today.map((item, index) => {
                  const active = program.current?.id === item.id;
                  const next = program.next?.id === item.id;
                  return (
                    <li className={`schedule-item${active ? " schedule-active" : ""}${next ? " schedule-next" : ""}`} key={item.id ?? `${item.date}-${item.start}-${index}`}>
                      <span className="schedule-marker" />
                      <div className="schedule-copy"><div className="schedule-time">{formatRange(item)}</div><div className="schedule-host">{item.host || "主播待安排"}</div></div>
                      <span className="schedule-state">{active ? "当前" : next ? "下一场" : ""}</span>
                    </li>
                  );
                })}
              </ol>
            ) : (
              <div className="empty-schedule">{rooms.length ? "所选直播间今日暂无排班。" : "管理员尚未上传直播间排班。"}</div>
            )}
          </section>
        </aside>

        <section className="display-stage" aria-label="直播间门口电子屏">
          <div className="stage-topline">
            <span>直播间现场信息</span>
            <span className={`live-pill${isLive ? " live-pill-on" : " live-pill-next"}`}><span className="live-dot" />{statusText}</span>
          </div>
          <div className="stage-main">
            <div className="stage-copy">
              <div className="room-heading"><div className="room-id-line">{room?.id ?? "—"}<span>号直播间</span></div><h1>{room?.name ?? "等待直播间信息"}</h1></div>
              <div className="stage-period"><div className="stage-date">{formatDate(nowDate)}</div><div className="time-strip"><span className="time-strip-label">{isLive ? "当前时段" : displayed ? "即将开始" : "排班时段"}</span><span className="time-strip-range">{formatRange(displayed)}</span></div></div>
            </div>
            <div className="portrait-frame">
              {displayed?.photo ? <img src={displayed.photo} alt={`${displayed.host || "本场"} 主播照片`} /> : <div className="portrait-empty"><span>本场尚未添加</span><span>主播照片</span></div>}
            </div>
            {displayed ? (
              <div className="role-grid"><RoleCard label="导演" value={displayed.director} /><RoleCard label="主播" value={displayed.host} featured /><RoleCard label="助播" value={displayed.assistant} /></div>
            ) : <div className="no-session">{room ? "当前没有可展示的排班" : "等待管理员上传直播间排班"}</div>}
          </div>
          <MerchandisingInfo products={displayed?.featuredProducts} salesTarget={displayed?.salesTarget} />
        </section>
      </main>
    </div>
  );
}
