import { useCallback, useEffect, useMemo, useRef, useState } from "react";

const THEME_STORAGE_KEY = "live-room-theme";

function initialTheme() {
  if (document.documentElement.dataset.theme === "dark") return "dark";
  try {
    return window.localStorage.getItem(THEME_STORAGE_KEY) === "dark" ? "dark" : "light";
  } catch {
    return "light";
  }
}

function ThemeToggle({ theme, onToggle }) {
  const dark = theme === "dark";
  return (
    <button
      className="theme-toggle"
      type="button"
      aria-label={`当前为${dark ? "暗色" : "浅色"}模式，切换到${dark ? "浅色" : "暗色"}模式`}
      aria-pressed={dark}
      onClick={onToggle}
    >
      <span className="theme-toggle-icon" aria-hidden="true">{dark ? "☾" : "☼"}</span>
      <span>{dark ? "暗色" : "浅色"}</span>
    </button>
  );
}

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

function scheduleHasEnded(group, slot, timestamp) {
  const startAt = atTime(group.date, slot.start);
  let endAt = atTime(group.date, slot.end);
  if (!Number.isFinite(startAt) || !Number.isFinite(endAt)) return false;
  if (endAt <= startAt) endAt += 24 * 60 * 60 * 1000;
  return endAt <= timestamp;
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
    today: sessions.filter((item) => item.date === today),
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
      <img className="brand-mark" src="/soho-logo.png" alt="SOHO 标识" />
      <div>
        <div className="brand-kicker">STUDIO DISPLAY</div>
        <div className="brand-title">直播间信息牌{compact ? " · 管理端" : ""}</div>
      </div>
    </div>
  );
}

function AuthHeader({ theme, onToggleTheme }) {
  return (
    <>
      <header className="auth-brand"><Brand /></header>
      <div className="auth-theme-control"><ThemeToggle theme={theme} onToggle={onToggleTheme} /></div>
    </>
  );
}

function LoginPage({ onLogin, theme, onToggleTheme }) {
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
      <AuthHeader theme={theme} onToggleTheme={onToggleTheme} />
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

function AvatarLibrary({ csrfToken }) {
  const [data, setData] = useState(null);
  const [pending, setPending] = useState([]);
  const [search, setSearch] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [replaceNames, setReplaceNames] = useState([]);
  const [replaceName, setReplaceName] = useState("");
  const [viewing, setViewing] = useState(null);
  const [removingId, setRemovingId] = useState("");
  const fileInput = useRef(null);
  const pendingRef = useRef(pending);

  useEffect(() => { pendingRef.current = pending; }, [pending]);
  useEffect(() => () => pendingRef.current.forEach((item) => URL.revokeObjectURL(item.previewUrl)), []);

  const loadLibrary = useCallback(async () => {
    const response = await api("/api/v1/admin/host-avatars");
    setData(response);
  }, []);

  useEffect(() => {
    loadLibrary().catch((cause) => setMessage(cause.message));
  }, [loadLibrary]);

  function inferredHostName(filename) {
    const base = filename.replace(/\.[^.]+$/, "").trim();
    const separator = base.indexOf("_");
    return separator > 0 ? base.slice(separator + 1).trim() : base;
  }

  function queueFiles(fileList, preferredName = "") {
    const selected = Array.from(fileList ?? []);
    if (!selected.length) return;
    if (pending.length + selected.length > 20) {
      setMessage("一次最多选择 20 张照片。");
      return;
    }
    if (pending.reduce((total, item) => total + item.file.size, 0) + selected.reduce((total, file) => total + file.size, 0) > 28 * 1024 * 1024) {
      setMessage("单次上传总大小不能超过 28 MB，请分批上传。");
      return;
    }
    const items = selected.map((file, index) => ({
      file,
      name: preferredName && index === 0 ? preferredName : inferredHostName(file.name),
      previewUrl: URL.createObjectURL(file),
    }));
    setPending((current) => current.concat(items));
    setMessage("");
    setReplaceNames([]);
  }

  function onSelectFiles(event) {
    queueFiles(event.target.files, replaceName);
    setReplaceName("");
    event.target.value = "";
  }

  function removePending(index) {
    const item = pending[index];
    if (item) URL.revokeObjectURL(item.previewUrl);
    setPending((current) => current.filter((_, itemIndex) => itemIndex !== index));
  }

  function clearPending() {
    pending.forEach((item) => URL.revokeObjectURL(item.previewUrl));
    setPending([]);
    setReplaceNames([]);
  }

  async function submitUpload(replaceExisting = false) {
    if (!pending.length || busy) return;
    if (pending.some((item) => !item.name.trim())) {
      setMessage("请给每张照片填写主播姓名。");
      return;
    }
    setBusy(true);
    setMessage("");
    const form = new FormData();
    form.append("names", JSON.stringify(pending.map((item) => item.name.trim())));
    form.append("replaceExisting", String(replaceExisting));
    pending.forEach((item) => form.append("photos", item.file, item.file.name));
    try {
      const response = await fetch("/api/v1/admin/host-avatars", {
        method: "POST",
        credentials: "same-origin",
        headers: { "x-csrf-token": csrfToken },
        body: form,
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        if (response.status === 409 && body.error?.code === "AVATAR_REPLACEMENT_CONFIRMATION_REQUIRED") {
          setReplaceNames((body.error.details ?? []).map((item) => item.name));
          return;
        }
        throw new Error(body.error?.message ?? "头像上传失败，请稍后重试。");
      }
      setData(body);
      setMessage("头像已保存：新增 " + body.createdCount + " 位，更新 " + body.updatedCount + " 位。展示页会自动同步。");
      clearPending();
    } catch (cause) {
      setMessage(cause.message);
    } finally {
      setBusy(false);
    }
  }

  async function removeAvatar(profile) {
    const usageText = profile.usedSlots ? "将影响 " + profile.usedSlots + " 个排班，展示页会改为头像占位。" : "这张照片将从头像库移除。";
    if (!window.confirm("确定移除“" + profile.name + "”的头像吗？" + usageText)) return;
    setRemovingId(profile.id);
    setMessage("");
    try {
      const response = await api("/api/v1/admin/host-avatars/" + encodeURIComponent(profile.id), {
        method: "DELETE",
        headers: { "x-csrf-token": csrfToken },
      });
      setData(response);
      setMessage("已移除“" + profile.name + "”的头像。");
    } catch (cause) {
      setMessage(cause.message);
    } finally {
      setRemovingId("");
    }
  }

  const profiles = data?.profiles ?? [];
  const visibleProfiles = profiles.filter((profile) => profile.name.toLocaleLowerCase("zh-CN").includes(search.trim().toLocaleLowerCase("zh-CN")));
  const invalidFiles = pending.filter((item) => item.file.size > 8 * 1024 * 1024 || !/\.(?:jpe?g|png)$/i.test(item.file.name));

  return (
    <section className="avatar-library">
      <div className="admin-card avatar-upload-card">
        <div className="admin-card-heading">
          <div className="admin-icon avatar-library-icon">◉</div>
          <div><h2>批量添加主播头像</h2><p>每位主播维护一张常用头像，排班中的姓名匹配后会自动展示。</p></div>
        </div>
        <input
          ref={fileInput}
          className="avatar-file-input"
          type="file"
          accept=".jpg,.jpeg,.png,image/jpeg,image/png"
          multiple
          onChange={onSelectFiles}
          aria-label="选择主播头像"
        />
        <div
          className="avatar-dropzone"
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => { event.preventDefault(); queueFiles(event.dataTransfer.files); }}
        >
          <div className="avatar-drop-glyph">＋</div>
          <strong>拖入照片，或从电脑选择</strong>
          <span>支持 JPG、PNG；每张不超过 8 MB；单次最多 20 张、合计 28 MB</span>
          <button className="button-primary avatar-choose-button" type="button" onClick={() => fileInput.current?.click()}>选择照片</button>
          <small>默认从文件名识别主播姓名；文件名可写为“主播编号_姓名.jpg”，提交前可修改。</small>
        </div>
        {pending.length > 0 && (
          <div className="avatar-pending">
            <div className="avatar-pending-heading"><strong>待上传 {pending.length} 张</strong><button type="button" className="avatar-text-button" onClick={clearPending}>清空</button></div>
            <div className="avatar-pending-grid">
              {pending.map((item, index) => (
                <div className="avatar-pending-item" key={item.previewUrl}>
                  <img src={item.previewUrl} alt={item.name || "待上传主播照片"} />
                  <label>主播姓名<input value={item.name} maxLength={80} onChange={(event) => setPending((current) => current.map((entry, entryIndex) => entryIndex === index ? { ...entry, name: event.target.value } : entry))} /></label>
                  <small>{item.file.name} · {(item.file.size / 1024 / 1024).toFixed(1)} MB</small>
                  <button type="button" className="avatar-remove-pending" aria-label={"移除 " + item.name} onClick={() => removePending(index)}>移除</button>
                </div>
              ))}
            </div>
            {replaceNames.length > 0 && (
              <div className="avatar-replace-confirm" role="alert">
                <div><strong>有 {replaceNames.length} 位主播已经有头像</strong><span>{replaceNames.join("、")}。替换后，所有使用这些主播的排班页面都会显示新头像。</span></div>
                <div className="avatar-confirm-actions">
                  <button type="button" className="avatar-secondary-button" onClick={() => setReplaceNames([])}>返回检查</button>
                  <button type="button" className="button-primary avatar-choose-button" disabled={busy || invalidFiles.length > 0} onClick={() => submitUpload(true)}>{busy ? "正在保存…" : "确认替换并保存"}</button>
                </div>
              </div>
            )}
            <div className="avatar-upload-actions">
              {invalidFiles.length > 0 && <span className="avatar-invalid-hint">请检查文件格式和单张大小。</span>}
              <button type="button" className="button-primary avatar-choose-button" disabled={busy || invalidFiles.length > 0 || pending.some((item) => !item.name.trim())} onClick={() => submitUpload(false)}>{busy ? "正在保存…" : "上传到头像库"}</button>
            </div>
          </div>
        )}
      </div>

      {message && <div className={"form-message" + (message.includes("失败") || message.includes("请") ? " form-error" : " form-success")} role="status">{message}</div>}

      {data?.conflicts?.length > 0 && (
        <aside className="avatar-conflict-note">
          <strong>有 {data.conflicts.length} 位主播存在不同的历史照片</strong>
          <span>{data.conflicts.map((item) => item.name + "（" + item.photoCount + " 张）").join("、")}。上传并确认统一头像后，所有排班页面将使用头像库中的照片。</span>
        </aside>
      )}

      <div className="avatar-library-toolbar">
        <div><span className="section-kicker">HOST DIRECTORY</span><h2>主播头像库</h2><p>管理员可以随时查看、放大预览和更换头像。</p></div>
        <label className="avatar-search">搜索主播<input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="输入主播姓名" /></label>
      </div>
      <div className="avatar-stats">
        <div><span>主播总数</span><strong>{data?.summary?.total ?? "—"}</strong></div>
        <div><span>已添加头像</span><strong>{data?.summary?.withPhoto ?? "—"}</strong></div>
        <div><span>待补充头像</span><strong>{data?.summary?.missingPhoto ?? "—"}</strong></div>
      </div>
      {data ? (
        visibleProfiles.length ? (
          <div className="avatar-profile-grid">
            {visibleProfiles.map((profile) => (
              <article className="avatar-profile-card" key={profile.id}>
                <button type="button" className="avatar-profile-image" onClick={() => profile.photoUrl && setViewing(profile)} disabled={!profile.photoUrl} aria-label={"预览 " + profile.name + " 的头像"}>
                  {profile.photoUrl ? <img src={profile.photoUrl} alt={profile.name + " 的头像"} /> : <span>暂无头像</span>}
                  {profile.photoUrl && <i>放大预览</i>}
                </button>
                <div className="avatar-profile-info">
                  <strong>{profile.name}</strong>
                  <span>{profile.usedSlots} 个排班使用</span>
                  <small>{profile.hasPhoto ? "更新于 " + new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(profile.updatedAt)) : "等待上传头像"}</small>
                </div>
                <div className="avatar-profile-actions">
                  <button type="button" className="avatar-secondary-button" onClick={() => { setReplaceName(profile.name); fileInput.current?.click(); }}>更换头像</button>
                  {profile.hasPhoto && <button type="button" className="avatar-text-button danger" disabled={removingId === profile.id} onClick={() => removeAvatar(profile)}>{removingId === profile.id ? "处理中…" : "移除"}</button>}
                </div>
              </article>
            ))}
          </div>
        ) : <div className="avatar-empty">{search ? "没有找到匹配的主播。" : "头像库还没有主播照片。可先批量选择照片上传。"} </div>
      ) : <div className="avatar-empty">正在读取头像库…</div>}

      {viewing && (
        <div className="avatar-preview-overlay" role="presentation" onClick={() => setViewing(null)}>
          <div className="avatar-preview-dialog" role="dialog" aria-modal="true" aria-label={viewing.name + " 头像预览"} onClick={(event) => event.stopPropagation()}>
            <button type="button" className="avatar-preview-close" aria-label="关闭预览" onClick={() => setViewing(null)}>×</button>
            <img src={viewing.photoUrl} alt={viewing.name + " 的头像"} />
            <strong>{viewing.name}</strong>
            <span>{viewing.usedSlots} 个排班使用</span>
          </div>
        </div>
      )}
    </section>
  );
}

function McpKeyManager({ csrfToken }) {
  const [tokens, setTokens] = useState(null);
  const [name, setName] = useState("");
  const [oneTimeToken, setOneTimeToken] = useState("");
  const [oneTimeTokenId, setOneTimeTokenId] = useState("");
  const [message, setMessage] = useState("");
  const [messageType, setMessageType] = useState("success");
  const [busy, setBusy] = useState(false);
  const [revokingId, setRevokingId] = useState("");
  const secretInput = useRef(null);

  const loadTokens = useCallback(async () => {
    const response = await api("/api/v1/admin/api-tokens");
    setTokens(response.tokens ?? []);
  }, []);

  useEffect(() => {
    loadTokens().catch((cause) => {
      setMessageType("error");
      setMessage(cause.message);
    });
  }, [loadTokens]);

  async function createToken(event) {
    event.preventDefault();
    if (busy || !name.trim()) return;
    setBusy(true);
    setMessage("");
    try {
      const response = await api("/api/v1/admin/api-tokens", {
        method: "POST",
        headers: { "content-type": "application/json", "x-csrf-token": csrfToken },
        body: JSON.stringify({ name: name.trim() }),
      });
      setTokens(response.tokens ?? []);
      setOneTimeToken(response.token);
      setOneTimeTokenId(response.id);
      setName("");
      setMessageType("success");
      setMessage("密钥已创建。请立即复制并保存；离开此页面后将无法再次查看。");
    } catch (cause) {
      setMessageType("error");
      setMessage(cause.message);
    } finally {
      setBusy(false);
    }
  }

  async function copyToken() {
    if (!oneTimeToken) return;
    try {
      await navigator.clipboard.writeText(oneTimeToken);
      setMessageType("success");
      setMessage("密钥已复制，请立即保存到对应 Harness 的安全配置中。");
    } catch {
      secretInput.current?.focus();
      secretInput.current?.select();
      setMessageType("error");
      setMessage("浏览器未开放剪贴板权限，已选中密钥，请按 Ctrl+C 手动复制。");
    }
  }

  async function revokeToken(item) {
    if (!window.confirm(`确定撤销“${item.name}”吗？连接它的 Harness 将无法继续访问 MCP。`)) return;
    setRevokingId(item.id);
    setMessage("");
    try {
      const response = await api(`/api/v1/admin/api-tokens/${encodeURIComponent(item.id)}`, {
        method: "DELETE",
        headers: { "x-csrf-token": csrfToken },
      });
      setTokens(response.tokens ?? []);
      setMessageType("success");
      setMessage(`已撤销“${item.name}”。`);
      if (item.id === oneTimeTokenId) {
        setOneTimeToken("");
        setOneTimeTokenId("");
      }
    } catch (cause) {
      setMessageType("error");
      setMessage(cause.message);
    } finally {
      setRevokingId("");
    }
  }

  function formatDate(value) {
    if (!value) return "尚未使用";
    return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
  }

  return (
    <section className="mcp-key-workspace" aria-label="MCP 密钥管理">
      <div className="mcp-key-intro">
        <div><span className="section-kicker">MCP ACCESS</span><h2>Harness 连接密钥</h2><p>为 Codex、WorkBuddy 等工具分别创建独立密钥。每把密钥都可以单独撤销。</p></div>
        <span className="mcp-key-shield" aria-hidden="true">⌘</span>
      </div>

      <form className="admin-card mcp-token-create-card" onSubmit={createToken}>
        <div className="admin-card-heading">
          <div className="admin-icon">＋</div>
          <div><h2>生成 MCP 密钥</h2><p>建议按使用工具命名，例如“Codex MCP”或“WorkBuddy MCP”。</p></div>
        </div>
        <div className="mcp-token-form-row">
          <label className="mcp-token-name-field" htmlFor="mcp-token-name">密钥用途名称<input id="mcp-token-name" value={name} maxLength={80} onChange={(event) => setName(event.target.value)} placeholder="例如：Codex MCP" required /></label>
          <button className="button-primary mcp-create-button" type="submit" disabled={busy || !name.trim()}>{busy ? "正在生成…" : "生成密钥"}</button>
        </div>
      </form>

      {oneTimeToken && (
        <div className="mcp-token-reveal" role="alert">
          <div className="mcp-token-reveal-heading"><span className="mcp-token-check">✓</span><div><strong>新密钥已生成</strong><span>出于安全考虑，完整密钥只显示这一次。</span></div></div>
          <div className="mcp-token-copy-row"><input ref={secretInput} aria-label="新生成的一次性 MCP 密钥" value={oneTimeToken} readOnly onFocus={(event) => event.target.select()} /><button type="button" className="mcp-copy-button" onClick={copyToken}>复制密钥</button></div>
          <p>现在将它粘贴到 Harness 的 MCP 连接配置中。关闭或刷新页面后，若未保存只能撤销并重新生成。</p>
        </div>
      )}

      {message && <div className={`form-message${messageType === "error" ? " form-error" : " form-success"}`} role={messageType === "error" ? "alert" : "status"}>{message}</div>}

      <div className="mcp-token-list-heading"><div><span className="section-kicker">KEY INVENTORY</span><h2>密钥列表</h2></div><span>{tokens?.length ?? "—"} 把</span></div>
      {tokens ? tokens.length ? (
        <div className="mcp-token-list">
          {tokens.map((item) => (
            <article className={`mcp-token-card${item.revokedAt ? " revoked" : ""}`} key={item.id}>
              <div className="mcp-token-card-main"><span className="mcp-token-mark" aria-hidden="true">⌘</span><div className="mcp-token-card-title"><strong>{item.name}</strong><span>创建于 {formatDate(item.createdAt)}</span></div></div>
              <div className="mcp-token-card-usage"><span className={`mcp-token-status${item.revokedAt ? " inactive" : ""}`}><i />{item.revokedAt ? "已撤销" : "有效"}</span><small>{item.revokedAt ? `撤销于 ${formatDate(item.revokedAt)}` : `最近使用：${formatDate(item.lastUsedAt)}`}</small></div>
              {!item.revokedAt && <button className="mcp-revoke-button" type="button" disabled={revokingId === item.id} onClick={() => revokeToken(item)}>{revokingId === item.id ? "处理中…" : "撤销密钥"}</button>}
            </article>
          ))}
        </div>
      ) : <div className="mcp-token-empty">还没有 MCP 密钥。生成后即可在 Harness 中连接直播间信息牌。</div> : <div className="mcp-token-empty">正在读取密钥列表…</div>}
      <aside className="mcp-key-security-note"><span>i</span><p>系统只保存密钥摘要。请勿将完整密钥提交到 GitHub、写入公开文档或发送到群聊；如果密钥泄露，请立即撤销并为对应 Harness 重新生成。</p></aside>
    </section>
  );
}

function AdminScheduleLibrary({ csrfToken }) {
  const [data, setData] = useState(null);
  const [now, setNow] = useState(() => Date.now());
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [roomFilter, setRoomFilter] = useState("all");
  const [dateFilter, setDateFilter] = useState("");
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState(null);
  const [editValues, setEditValues] = useState(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [messageType, setMessageType] = useState("success");

  const loadSchedules = useCallback(async () => {
    setLoading(true);
    setLoadError("");
    try {
      setData(await api("/api/v1/admin/schedules"));
    } catch (cause) {
      setLoadError(cause.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadSchedules(); }, [loadSchedules]);

  useEffect(() => {
    const updateNow = () => setNow(Date.now());
    const interval = window.setInterval(updateNow, 15_000);
    document.addEventListener("visibilitychange", updateNow);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", updateNow);
    };
  }, []);

  const filteredGroups = useMemo(() => {
    const query = search.trim().toLocaleLowerCase("zh-CN");
    return (data?.groups ?? []).flatMap((group) => {
      if (roomFilter !== "all" && group.roomCode !== roomFilter) return [];
      if (dateFilter && group.date !== dateFilter) return [];
      const slots = group.slots.filter((slot) => !query || [
        slot.start, slot.end, slot.director, slot.host, slot.assistant, slot.salesTarget, slot.notes,
        ...slot.featuredProducts,
      ].some((value) => String(value ?? "").toLocaleLowerCase("zh-CN").includes(query)));
      return slots.length ? [{ ...group, slots }] : [];
    });
  }, [data, dateFilter, roomFilter, search]);

  const { activeGroups, archivedGroups } = useMemo(() => filteredGroups.reduce((result, group) => {
    const activeSlots = [];
    const archivedSlots = [];
    for (const slot of group.slots) {
      (scheduleHasEnded(group, slot, now) ? archivedSlots : activeSlots).push(slot);
    }
    if (activeSlots.length) result.activeGroups.push({ ...group, slots: activeSlots });
    if (archivedSlots.length) result.archivedGroups.push({ ...group, slots: archivedSlots });
    return result;
  }, { activeGroups: [], archivedGroups: [] }), [filteredGroups, now]);

  const filteredCount = filteredGroups.reduce((count, group) => count + group.slots.length, 0);
  const archivedCount = archivedGroups.reduce((count, group) => count + group.slots.length, 0);

  function beginEdit(group, slot) {
    const key = `${group.roomCode}\u0000${group.date}\u0000${slot.id}`;
    setEditing({ key, roomCode: group.roomCode, date: group.date, slotId: slot.id });
    setEditValues({
      start: slot.start,
      end: slot.end,
      director: slot.director,
      host: slot.host,
      assistant: slot.assistant,
      products: slot.featuredProducts.join("\n"),
      salesTarget: slot.salesTarget,
      notes: slot.notes,
    });
    setMessage("");
  }

  function updateEdit(field, value) {
    setEditValues((current) => ({ ...current, [field]: value }));
  }

  function renderGroup(group) {
    return (
      <article className="schedule-group" key={`${group.roomCode}-${group.date}`}>
        <header className="schedule-group-heading"><div><h3>{group.roomName}</h3><time>{group.date}</time></div><span>{group.slots.length} 场</span></header>
        <div className="schedule-table-wrap">
          <table className="schedule-table">
            <thead><tr><th>时段</th><th>导演</th><th>主播</th><th>助播</th><th>主推商品</th><th>目标销售额</th><th>头像</th><th>备注</th><th>操作</th></tr></thead>
            <tbody>{group.slots.map((slot) => {
              const key = `${group.roomCode}\u0000${group.date}\u0000${slot.id}`;
              const isEditing = editing?.key === key;
              return isEditing ? (
                <tr className="schedule-edit-row" key={slot.id}>
                  <td colSpan="9">
                    <form className="schedule-edit-form" onSubmit={(event) => saveEdit(event, group, slot)}>
                      <label>开始时间<input type="time" value={editValues.start} onChange={(event) => updateEdit("start", event.target.value)} required /></label>
                      <label>结束时间<input type="time" value={editValues.end} onChange={(event) => updateEdit("end", event.target.value)} required /></label>
                      <label>导演<input value={editValues.director} maxLength={80} onChange={(event) => updateEdit("director", event.target.value)} /></label>
                      <label>主播<input value={editValues.host} maxLength={80} onChange={(event) => updateEdit("host", event.target.value)} /></label>
                      <label>助播<input value={editValues.assistant} maxLength={80} onChange={(event) => updateEdit("assistant", event.target.value)} /></label>
                      <label className="schedule-edit-wide">主推商品（每行一项）<textarea value={editValues.products} maxLength={6000} rows={3} onChange={(event) => updateEdit("products", event.target.value)} /></label>
                      <label>目标销售额<input value={editValues.salesTarget} maxLength={32} onChange={(event) => updateEdit("salesTarget", event.target.value)} placeholder="例如：200000 或 20万" /></label>
                      <label className="schedule-edit-wide">备注<textarea value={editValues.notes} maxLength={500} rows={2} onChange={(event) => updateEdit("notes", event.target.value)} /></label>
                      <div className="schedule-edit-actions"><button className="avatar-secondary-button" type="button" onClick={cancelEdit} disabled={saving}>取消</button><button className="button-primary schedule-save-button" type="submit" disabled={saving}>{saving ? "正在保存…" : "保存修改"}</button></div>
                    </form>
                  </td>
                </tr>
              ) : (
                <tr key={slot.id}>
                  <td className="schedule-time-cell">{slot.start}–{slot.end}</td><td>{slot.director || "—"}</td><td>{slot.host || "—"}</td><td>{slot.assistant || "—"}</td>
                  <td className="schedule-products-cell">{slot.featuredProducts.length ? slot.featuredProducts.join("、") : "—"}</td><td>{slot.salesTarget || "—"}</td>
                  <td><span className={`schedule-avatar-status${slot.hasAvatar ? " ready" : " missing"}`}>{slot.hasAvatar ? slot.avatarSource : "未配置"}</span></td><td className="schedule-notes-cell">{slot.notes || "—"}</td>
                  <td><button className="avatar-text-button schedule-edit-button" type="button" onClick={() => beginEdit(group, slot)}>编辑</button></td>
                </tr>
              );
            })}</tbody>
          </table>
        </div>
      </article>
    );
  }

  function cancelEdit() {
    setEditing(null);
    setEditValues(null);
  }

  async function saveEdit(event, group, slot) {
    event.preventDefault();
    if (saving || !editValues) return;
    setSaving(true);
    setMessage("");
    const updatedSlot = {
      ...slot,
      start: editValues.start,
      end: editValues.end,
      director: editValues.director,
      host: editValues.host,
      assistant: editValues.assistant,
      featuredProducts: editValues.products.split(/[\r\n;；、]+/).map((item) => item.trim()).filter(Boolean),
      salesTarget: editValues.salesTarget,
      notes: editValues.notes,
    };
    // Filters can hide siblings, so submit the complete unfiltered day from the source payload.
    const completeGroup = data.groups.find((item) => item.roomCode === group.roomCode && item.date === group.date);
    const completeSlots = completeGroup.slots.map((item) => item.id === slot.id ? updatedSlot : item);
    try {
      await api("/api/v1/admin/schedules", {
        method: "PUT",
        headers: { "content-type": "application/json", "x-csrf-token": csrfToken },
        body: JSON.stringify({
          roomCode: group.roomCode,
          date: group.date,
          dataUpdatedAt: data.dataUpdatedAt,
          slots: completeSlots,
        }),
      });
      await loadSchedules();
      setEditing(null);
      setEditValues(null);
      setMessageType("success");
      setMessage(`已保存 ${group.roomName} ${group.date} 的排班修改。`);
    } catch (cause) {
      if (cause.status === 409) {
        setEditing(null);
        setEditValues(null);
        await loadSchedules();
        setMessageType("error");
        setMessage("排班数据刚刚有更新，列表已刷新。请重新打开这一场再修改。");
      } else {
        const details = cause.body?.error?.details ?? [];
        setMessageType("error");
        setMessage(details.length ? `${cause.message}：${details.map((item) => item.message).join("；")}` : cause.message);
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="schedule-library" role="tabpanel" aria-label="已录入排班">
      <div className="schedule-library-toolbar">
        <div><span className="section-kicker">SAVED SCHEDULES</span><h2>已录入排班</h2><p>查看已保存的直播间时段；发现错误可直接编辑对应场次。</p></div>
        <button className="avatar-secondary-button schedule-refresh-button" type="button" onClick={loadSchedules} disabled={loading}>{loading ? "正在刷新…" : "刷新列表"}</button>
      </div>

      <div className="schedule-library-filters">
        <label>直播间<select value={roomFilter} onChange={(event) => setRoomFilter(event.target.value)}><option value="all">全部直播间</option>{(data?.rooms ?? []).map((room) => <option key={room.code} value={room.code}>{room.name}</option>)}</select></label>
        <label>排班日期<input type="date" value={dateFilter} onChange={(event) => setDateFilter(event.target.value)} /></label>
        <label className="schedule-search">搜索主播、商品或备注<input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="输入关键词" /></label>
        <div className="schedule-library-count">{loading && !data ? "读取中…" : `共 ${data?.scheduleCount ?? 0} 场 · 当前筛选 ${filteredCount} 场 · 已归档 ${archivedCount} 场`}</div>
      </div>

      {message && <div className={`form-message${messageType === "error" ? " form-error" : " form-success"}`} role={messageType === "error" ? "alert" : "status"}>{message}</div>}
      {loadError && <div className="form-message form-error" role="alert">读取排班失败：{loadError}</div>}
      {loading && !data ? <div className="schedule-library-empty">正在读取已录入的排班…</div> : null}
      {!loading && !loadError && filteredCount === 0 && <div className="schedule-library-empty">没有符合条件的排班记录。</div>}
      {!loading && !loadError && filteredCount > 0 && activeGroups.length === 0 && <div className="schedule-library-empty">当前筛选下的排班都已归档，请展开下方“已归档”查看。</div>}

      {activeGroups.map(renderGroup)}

      {!loading && !loadError && data && (
        <details className="schedule-archive">
          <summary><span className="schedule-archive-title">已归档</span><span className="schedule-archive-count">{archivedCount} 场</span></summary>
          <div className="schedule-archive-content">
            {archivedGroups.length ? archivedGroups.map(renderGroup) : <div className="schedule-archive-empty">当前筛选下没有已结束的排班。</div>}
          </div>
        </details>
      )}
    </section>
  );
}

function AdminPage({ user, csrfToken, onLogout, theme, onToggleTheme }) {
  const [activeTab, setActiveTab] = useState("schedule");
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
        <ThemeToggle theme={theme} onToggle={onToggleTheme} />
          <button className="topbar-action" type="button" onClick={onLogout}>退出</button>
        </div>
      </header>
      <main className="admin-workspace">
        <section className="admin-hero">
          <div className="section-kicker">DATA MANAGEMENT</div>
          <h1>排班信息管理</h1>
          <p>每个工作表对应一个直播间。上传完整工作簿后，系统会先校验所有工作表，再一次性更新展示数据。<a className="template-link" href="/live-room-schedule-template.xlsx" download>下载空白模板</a></p>
        </section>
        <div className="admin-tabs" role="tablist" aria-label="管理内容">
          <button type="button" role="tab" aria-selected={activeTab === "schedule"} className={activeTab === "schedule" ? "admin-tab active" : "admin-tab"} onClick={() => setActiveTab("schedule")}>排班 Excel</button>
          <button type="button" role="tab" aria-selected={activeTab === "records"} className={activeTab === "records" ? "admin-tab active" : "admin-tab"} onClick={() => setActiveTab("records")}>已录入排班</button>
          <button type="button" role="tab" aria-selected={activeTab === "avatars"} className={activeTab === "avatars" ? "admin-tab active" : "admin-tab"} onClick={() => setActiveTab("avatars")}>主播头像库</button>
          <button type="button" role="tab" aria-selected={activeTab === "keys"} className={activeTab === "keys" ? "admin-tab active" : "admin-tab"} onClick={() => setActiveTab("keys")}>MCP 密钥</button>
        </div>
        {activeTab === "schedule" ? <>
        <section className="admin-card" role="tabpanel">
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
        <aside className="admin-note"><span>i</span><div><strong>更新规则与照片说明</strong><p>工作簿任一直播间存在错误时，本次导入不会改变正在展示的数据。主播照片可在“主播头像库”集中维护；排班 Excel 中已有的行内照片仍会兼容显示。新主播首次导入时，如果每场照片一致，系统会自动收录到头像库。</p></div></aside>
        </> : activeTab === "records" ? <AdminScheduleLibrary csrfToken={csrfToken} /> : activeTab === "avatars" ? <div role="tabpanel"><AvatarLibrary csrfToken={csrfToken} /></div> : <div role="tabpanel"><McpKeyManager csrfToken={csrfToken} /></div>}
      </main>
      <footer className="admin-footer">直播间信息牌 <span>·</span> 管理工作台</footer>
    </div>
  );
}

export function App() {
  const [theme, setTheme] = useState(initialTheme);
  const [authLoading, setAuthLoading] = useState(true);
  const [user, setUser] = useState(null);
  const [csrfToken, setCsrfToken] = useState("");
  const [rooms, setRooms] = useState([]);
  const [roomId, setRoomId] = useState("");
  const [displayData, setDisplayData] = useState(null);
  const [serverOffset, setServerOffset] = useState(0);
  const [realTime, setRealTime] = useState(Date.now());
  const [connectionError, setConnectionError] = useState("");

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try { window.localStorage.setItem(THEME_STORAGE_KEY, theme); } catch {}
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", theme === "dark" ? "#0b0e13" : "#edf2f7");
  }, [theme]);

  const toggleTheme = useCallback(() => {
    setTheme((current) => current === "dark" ? "light" : "dark");
  }, []);

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
  if (!user) return <LoginPage onLogin={login} theme={theme} onToggleTheme={toggleTheme} />;
  if (user.role === "admin") return <AdminPage user={user} csrfToken={csrfToken} onLogout={logout} theme={theme} onToggleTheme={toggleTheme} />;

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
          <ThemeToggle theme={theme} onToggle={toggleTheme} />
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
