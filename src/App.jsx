import { StaffScheduleImport } from "./staff-import.jsx";
import { DisplayRoomPicker, RoomManagement } from "./room-management.jsx";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

const THEME_STORAGE_KEY = "live-room-theme";
const ROOM_ID_STORAGE_KEY = "live-room-selected-id";
const ROOM_CODE_STORAGE_KEY = "live-room-selected";

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

function getProgram(items, timestamp) {
  const today = dateKey(new Date(timestamp));
  const yesterdayDate = new Date(`${today}T00:00:00+08:00`);
  yesterdayDate.setUTCDate(yesterdayDate.getUTCDate() - 1);
  const yesterday = dateKey(yesterdayDate);
  const sessions = (items ?? [])
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

function RoleCard({ label, value, time, featured = false }) {
  return (
    <section className={`role-card${featured ? " role-card-featured" : ""}`}>
      <div className="role-label">{label}</div>
      <div className="role-name">{value || "待安排"}</div>
      {time && <div className="role-time">{time}</div>}
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

function revealAvatarUpload(section) {
  if (!section) return;
  section.focus({ preventScroll: true });
  section.scrollIntoView({
    block: "start",
    behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth",
  });
}

function AvatarLibrary({ csrfToken }) {
  const [data, setData] = useState(null);
  const [pending, setPending] = useState([]);
  const [search, setSearch] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [replaceNames, setReplaceNames] = useState([]);
  const [viewing, setViewing] = useState(null);
  const [avatarAction, setAvatarAction] = useState(null);
  const [nameDraft, setNameDraft] = useState(null);
  const [nameError, setNameError] = useState("");
  const [savingName, setSavingName] = useState(false);
  const fileInput = useRef(null);
  const selectedHost = useRef("");
  const pendingSection = useRef(null);
  const replacementSection = useRef(null);
  const revealPending = useRef(false);
  const pendingRef = useRef(pending);
  const changingAvatar = busy || savingName || Boolean(avatarAction);

  useEffect(() => { pendingRef.current = pending; }, [pending]);
  useEffect(() => () => pendingRef.current.forEach((item) => URL.revokeObjectURL(item.previewUrl)), []);
  useEffect(() => {
    if (!revealPending.current || !pendingSection.current) return;
    revealPending.current = false;
    revealAvatarUpload(pendingSection.current);
  }, [pending]);
  useEffect(() => {
    if (replaceNames.length) revealAvatarUpload(replacementSection.current);
  }, [replaceNames]);

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
    if (changingAvatar || !selected.length) return;
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
    revealPending.current = true;
    setPending((current) => current.concat(items));
    setMessage("");
    setReplaceNames([]);
  }

  function chooseFiles(hostName = "") {
    if (changingAvatar) return;
    selectedHost.current = hostName;
    fileInput.current?.click();
  }

  function onSelectFiles(event) {
    queueFiles(event.target.files, selectedHost.current);
    selectedHost.current = "";
    event.target.value = "";
  }

  function removePending(index) {
    const item = pending[index];
    if (item) URL.revokeObjectURL(item.previewUrl);
    setPending((current) => current.filter((_, itemIndex) => itemIndex !== index));
    setReplaceNames([]);
  }

  function clearPending() {
    pending.forEach((item) => URL.revokeObjectURL(item.previewUrl));
    setPending([]);
    setReplaceNames([]);
  }

  async function submitUpload(replaceExisting = false) {
    if (!pending.length || changingAvatar) return;
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

  async function removeAvatar(profile, action) {
    if (changingAvatar) return;
    const deleting = action === "profile";
    const subject = `“${profile.name}”`;
    const question = deleting ? `确定删除主播 ${subject} 的档案和头像吗？` : `确定移除 ${subject} 的头像吗？`;
    const usage = profile.usedSlots ? `关联的 ${profile.usedSlots} 条排班会保留，展示页显示头像占位。` : "";
    if (!window.confirm(question + usage)) return;
    setAvatarAction({ id: profile.id, action });
    setMessage("");
    try {
      const path = "/api/v1/admin/host-avatars/" + encodeURIComponent(profile.id);
      const headers = { "x-csrf-token": csrfToken };
      const response = await api(deleting ? path + "/profile" : path, {
        method: "DELETE",
        headers: deleting ? { ...headers, "content-type": "application/json" } : headers,
        body: deleting ? JSON.stringify({ expectedName: profile.name }) : undefined,
      });
      setData(response);
      setViewing((current) => current?.id === profile.id ? null : current);
      if (deleting && nameDraft?.id === profile.id) {
        setNameDraft(null);
        setNameError("");
      }
      setMessage(deleting ? `已删除主播 ${subject}。` : `已移除 ${subject} 的头像。`);
    } catch (cause) {
      setMessage(cause.message);
    } finally {
      setAvatarAction(null);
    }
  }

  function beginRename(profile) {
    setNameDraft({ id: profile.id, previousName: profile.name, value: profile.name });
    setNameError("");
    setMessage("");
  }

  async function saveName(event) {
    event.preventDefault();
    const name = nameDraft?.value.trim();
    if (!name || name === nameDraft.previousName || changingAvatar) return;
    setSavingName(true);
    setNameError("");
    try {
      const response = await api("/api/v1/admin/host-avatars/" + encodeURIComponent(nameDraft.id), {
        method: "PATCH",
        headers: { "content-type": "application/json", "x-csrf-token": csrfToken },
        body: JSON.stringify({ name, expectedName: nameDraft.previousName }),
      });
      setData(response);
      setNameDraft(null);
      setSearch((value) => name.toLocaleLowerCase("zh-CN").includes(value.trim().toLocaleLowerCase("zh-CN")) ? value : "");
      setMessage(response.updatedScheduleCount
        ? `已保存姓名，同步更新 ${response.updatedScheduleCount} 条排班。`
        : "已保存主播姓名。");
    } catch (cause) {
      setNameError(cause.message);
    } finally {
      setSavingName(false);
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
          disabled={changingAvatar}
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
          <button className="button-primary avatar-choose-button" type="button" disabled={changingAvatar} onClick={() => chooseFiles()}>选择照片</button>
          <small>默认从文件名识别主播姓名；文件名可写为“主播编号_姓名.jpg”，提交前可修改。</small>
        </div>
        {pending.length > 0 && (
          <section className="avatar-pending" ref={pendingSection} tabIndex={-1} aria-labelledby="avatar-pending-title" aria-busy={busy}>
            <div className="avatar-pending-heading">
              <strong id="avatar-pending-title">待上传 {pending.length} 张</strong>
              <div className="avatar-upload-actions">
                <button type="button" className="avatar-text-button" disabled={changingAvatar} onClick={clearPending}>清空</button>
                {!replaceNames.length && (
                  <button type="button" className="button-primary avatar-choose-button" disabled={changingAvatar || invalidFiles.length > 0 || pending.some((item) => !item.name.trim())} onClick={() => submitUpload()}>{busy ? "正在上传…" : "上传到头像库"}</button>
                )}
              </div>
            </div>
            {invalidFiles.length > 0 && <p className="avatar-invalid-hint">请检查文件格式和单张大小。</p>}
            <div className="avatar-pending-grid">
              {pending.map((item, index) => (
                <div className="avatar-pending-item" key={item.previewUrl}>
                  <img src={item.previewUrl} alt={item.name || "待上传主播照片"} />
                  <label>主播姓名<input value={item.name} maxLength={80} disabled={changingAvatar} onChange={(event) => {
                    setPending((current) => current.map((entry, entryIndex) => entryIndex === index ? { ...entry, name: event.target.value } : entry));
                    setReplaceNames([]);
                  }} /></label>
                  <small>{item.file.name} · {(item.file.size / 1024 / 1024).toFixed(1)} MB</small>
                  <button type="button" className="avatar-remove-pending" aria-label={"移除 " + item.name} disabled={changingAvatar} onClick={() => removePending(index)}>移除</button>
                </div>
              ))}
            </div>
            {replaceNames.length > 0 && (
              <div className="avatar-replace-confirm" ref={replacementSection} tabIndex={-1} role="alert">
                <div><strong>有 {replaceNames.length} 位主播已经有头像</strong><span>{replaceNames.join("、")}。替换后，所有使用这些主播的排班页面都会显示新头像。</span></div>
                <div className="avatar-confirm-actions">
                  <button type="button" className="avatar-secondary-button" disabled={changingAvatar} onClick={() => {
                    setReplaceNames([]);
                    revealAvatarUpload(pendingSection.current);
                  }}>返回检查</button>
                  <button type="button" className="button-primary avatar-choose-button" disabled={changingAvatar || invalidFiles.length > 0} onClick={() => submitUpload(true)}>{busy ? "正在上传…" : "确认替换并保存"}</button>
                </div>
              </div>
            )}
          </section>
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
        <div><span className="section-kicker">HOST DIRECTORY</span><h2>主播头像库</h2><p>查看头像、编辑姓名和更换照片。</p></div>
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
                  <div className="avatar-profile-name">
                    <strong title={profile.name}>{profile.name}</strong>
                    {nameDraft?.id !== profile.id && (
                      <button type="button" className="avatar-text-button" disabled={changingAvatar}
                        aria-label={"编辑 " + profile.name + " 的姓名"} onClick={() => beginRename(profile)}>编辑姓名</button>
                    )}
                  </div>
                  <span>{profile.usedSlots} 个排班使用</span>
                  <small>{profile.hasPhoto ? "更新于 " + new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(profile.updatedAt)) : "等待上传头像"}</small>
                  {nameDraft?.id === profile.id && (
                    <form className="avatar-name-form" onSubmit={saveName}>
                      <label>新姓名
                        <input value={nameDraft.value} autoFocus required maxLength={80} disabled={savingName}
                          onChange={(event) => { setNameDraft({ ...nameDraft, value: event.target.value }); setNameError(""); }} />
                      </label>
                      {profile.usedSlots > 0 && <small>保存后同步更新 {profile.usedSlots} 条排班中的主播姓名。</small>}
                      {nameError && <div className="form-message form-error" role="alert">{nameError}</div>}
                      <div className="avatar-name-actions">
                        <button type="button" className="avatar-secondary-button" disabled={savingName}
                          onClick={() => { setNameDraft(null); setNameError(""); }}>取消</button>
                        <button type="submit" className="button-primary avatar-choose-button"
                          disabled={changingAvatar || !nameDraft.value.trim() || nameDraft.value.trim() === nameDraft.previousName}>
                          {savingName ? "正在保存…" : "保存姓名"}
                        </button>
                      </div>
                    </form>
                  )}
                </div>
                <div className="avatar-profile-actions">
                  <button type="button" className="avatar-secondary-button" disabled={changingAvatar} onClick={() => chooseFiles(profile.name)}>更换头像</button>
                  {profile.hasPhoto && (
                    <button type="button" className="avatar-text-button danger" disabled={changingAvatar} onClick={() => removeAvatar(profile, "photo")}>
                      {avatarAction?.id === profile.id && avatarAction.action === "photo" ? "处理中…" : "移除头像"}
                    </button>
                  )}
                  <button type="button" className="avatar-text-button danger" disabled={changingAvatar} onClick={() => removeAvatar(profile, "profile")}>
                    {avatarAction?.id === profile.id && avatarAction.action === "profile" ? "删除中…" : "删除主播"}
                  </button>
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

const scheduleRoleLabels = { host: "主播", director: "导演", assistant: "助播" };

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
        `${scheduleRoleLabels[slot.kind]}排班`,
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
    setEditing({ key, roomCode: group.roomCode, date: group.date, slotId: slot.id, kind: slot.kind });
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
        <header className="schedule-group-heading"><div><h3>{group.roomName}</h3><time>{group.date}</time></div><span>{group.slots.length} 条</span></header>
        <div className="schedule-table-wrap">
          <table className="schedule-table">
            <thead><tr><th>类型</th><th>时段</th><th>导演</th><th>主播</th><th>助播</th><th>主推商品</th><th>目标销售额</th><th>头像</th><th>备注</th><th>操作</th></tr></thead>
            <tbody>{group.slots.map((slot) => {
              const key = `${group.roomCode}\u0000${group.date}\u0000${slot.id}`;
              const isEditing = editing?.key === key;
              return isEditing ? (
                <tr className="schedule-edit-row" key={slot.id}>
                  <td colSpan="10">
                    <form className="schedule-edit-form" onSubmit={(event) => saveEdit(event, group, slot)}>
                      <label>开始时间<input type="time" value={editValues.start} onChange={(event) => updateEdit("start", event.target.value)} required /></label>
                      <label>结束时间<input type="time" value={editValues.end} onChange={(event) => updateEdit("end", event.target.value)} required /></label>
                      <label>{scheduleRoleLabels[slot.kind]}<input value={editValues[slot.kind]} maxLength={80} onChange={(event) => updateEdit(slot.kind, event.target.value)} required /></label>
                      {slot.kind === "host" && <>
                        <label className="schedule-edit-wide">主推商品（逗号或换行分隔）<textarea value={editValues.products} rows={3} onChange={(event) => updateEdit("products", event.target.value)} /></label>
                        <label>目标销售额
                          <span className="schedule-target-field" data-value={editValues.salesTarget}>
                            <textarea className="schedule-target-input" value={editValues.salesTarget} rows={2} onChange={(event) => updateEdit("salesTarget", event.target.value)} placeholder="按原文显示" />
                          </span>
                        </label>
                        <label className="schedule-edit-wide">备注<textarea value={editValues.notes} maxLength={500} rows={2} onChange={(event) => updateEdit("notes", event.target.value)} /></label>
                      </>}
                      <div className="schedule-edit-actions"><button className="avatar-secondary-button" type="button" onClick={cancelEdit} disabled={saving}>取消</button><button className="button-primary schedule-save-button" type="submit" disabled={saving}>{saving ? "正在保存…" : "保存修改"}</button></div>
                    </form>
                  </td>
                </tr>
              ) : (
                <tr key={slot.id}>
                  <td>{scheduleRoleLabels[slot.kind]}排班</td><td className="schedule-time-cell">{slot.start}–{slot.end}</td><td>{slot.director || "—"}</td><td>{slot.host || "—"}</td><td>{slot.assistant || "—"}</td>
                  <td className="schedule-products-cell">{slot.featuredProducts.length ? slot.featuredProducts.join("、") : "—"}</td><td className="schedule-target-cell">{slot.salesTarget || "—"}</td>
                  <td>{slot.kind === "host" ? <span className={`schedule-avatar-status${slot.hasAvatar ? " ready" : " missing"}`}>{slot.hasAvatar ? slot.avatarSource : "未配置"}</span> : "—"}</td><td className="schedule-notes-cell">{slot.notes || "—"}</td>
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
    const updatedSlot = { ...slot, start: editValues.start, end: editValues.end, [slot.kind]: editValues[slot.kind] };
    if (slot.kind === "host") {
      updatedSlot.featuredProducts = editValues.products === slot.featuredProducts.join("\n")
        ? slot.featuredProducts
        : editValues.products.split(/[\r\n,，]+/).map((item) => item.trim()).filter(Boolean);
      updatedSlot.salesTarget = editValues.salesTarget;
      updatedSlot.notes = editValues.notes;
    }
    // Filters can hide siblings, so submit the complete unfiltered day from the source payload.
    const completeGroup = data.groups.find((item) => item.roomCode === group.roomCode && item.date === group.date);
    const completeSlots = completeGroup.slots.map((item) => item.id === slot.id ? updatedSlot : item);
    const directorShifts = completeSlots.filter((item) => item.kind === "director")
      .map(({ id, start, end, director }) => ({ id, start, end, director }));
    const hostShifts = completeSlots.filter((item) => item.kind === "host")
      .map(({ id, start, end, host, featuredProducts, salesTarget, notes }) => ({ id, start, end, host, featuredProducts, salesTarget, notes }));
    const assistantShifts = completeSlots.filter((item) => item.kind === "assistant")
      .map(({ start, end, assistant }) => ({ start, end, assistant }));
    try {
      await api("/api/v1/admin/schedules", {
        method: "PUT",
        headers: { "content-type": "application/json", "x-csrf-token": csrfToken },
        body: JSON.stringify({
          roomCode: group.roomCode,
          date: group.date,
          dataUpdatedAt: data.dataUpdatedAt,
          directorShifts,
          hostShifts,
          assistantShifts,
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
        <div><span className="section-kicker">SAVED SCHEDULES</span><h2>已录入排班</h2><p>查看已保存的直播间排班；发现错误可分别编辑导演班次或主播场次。</p></div>
        <button className="avatar-secondary-button schedule-refresh-button" type="button" onClick={loadSchedules} disabled={loading}>{loading ? "正在刷新…" : "刷新列表"}</button>
      </div>

      <div className="schedule-library-filters">
        <label>直播间<select value={roomFilter} onChange={(event) => setRoomFilter(event.target.value)}><option value="all">全部直播间</option>{(data?.rooms ?? []).map((room) => <option key={room.code} value={room.code}>{room.name}</option>)}</select></label>
        <label>排班日期<input type="date" value={dateFilter} onChange={(event) => setDateFilter(event.target.value)} /></label>
        <label className="schedule-search">搜索导演、主播、商品或备注<input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="输入关键词" /></label>
         <div className="schedule-library-count">{loading && !data ? "读取中…" : `主播 ${data?.scheduleCount ?? 0} 场 · 导演 ${data?.directorShiftCount ?? 0} 班 · 助播 ${data?.assistantShiftCount ?? 0} 班 · 筛选 ${filteredCount} 条 · 已归档 ${archivedCount} 条`}</div>
      </div>

      {message && <div className={`form-message${messageType === "error" ? " form-error" : " form-success"}`} role={messageType === "error" ? "alert" : "status"}>{message}</div>}
      {loadError && <div className="form-message form-error" role="alert">读取排班失败：{loadError}</div>}
      {loading && !data ? <div className="schedule-library-empty">正在读取已录入的排班…</div> : null}
      {!loading && !loadError && filteredCount === 0 && <div className="schedule-library-empty">没有符合条件的排班记录。</div>}
      {!loading && !loadError && filteredCount > 0 && activeGroups.length === 0 && <div className="schedule-library-empty">当前筛选下的排班都已归档，请展开下方“已归档”查看。</div>}

      {activeGroups.map(renderGroup)}

      {!loading && !loadError && data && (
        <details className="schedule-archive">
          <summary><span className="schedule-archive-title">已归档</span><span className="schedule-archive-count">{archivedCount} 条</span></summary>
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
          <p>上传员工排班表，按直播间和日期更新排班。</p>
        </section>
        <div className="admin-tabs" role="tablist" aria-label="管理内容">
          <button type="button" role="tab" aria-selected={activeTab === "schedule"} className={activeTab === "schedule" ? "admin-tab active" : "admin-tab"} onClick={() => setActiveTab("schedule")}>排班 Excel</button>
          <button type="button" role="tab" aria-selected={activeTab === "records"} className={activeTab === "records" ? "admin-tab active" : "admin-tab"} onClick={() => setActiveTab("records")}>已录入排班</button>
          <button type="button" role="tab" id="room-management-tab" aria-controls={activeTab === "rooms" ? "room-management-panel" : undefined} aria-selected={activeTab === "rooms"} className={activeTab === "rooms" ? "admin-tab active" : "admin-tab"} onClick={() => setActiveTab("rooms")}>直播间管理</button>
          <button type="button" role="tab" aria-selected={activeTab === "avatars"} className={activeTab === "avatars" ? "admin-tab active" : "admin-tab"} onClick={() => setActiveTab("avatars")}>主播头像库</button>
          <button type="button" role="tab" aria-selected={activeTab === "keys"} className={activeTab === "keys" ? "admin-tab active" : "admin-tab"} onClick={() => setActiveTab("keys")}>MCP 密钥</button>
        </div>
        <StaffScheduleImport api={api} csrfToken={csrfToken} hidden={activeTab !== "schedule"} onViewRecords={() => setActiveTab("records")} />
        {activeTab === "records" && <AdminScheduleLibrary csrfToken={csrfToken} />}
        {activeTab === "rooms" && <RoomManagement api={api} csrfToken={csrfToken} />}
        {activeTab === "avatars" && <div role="tabpanel"><AvatarLibrary csrfToken={csrfToken} /></div>}
        {activeTab === "keys" && <div role="tabpanel"><McpKeyManager csrfToken={csrfToken} /></div>}
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
  const [selectedRoomId, setSelectedRoomId] = useState("");
  const [displayData, setDisplayData] = useState(null);
  const [serverOffset, setServerOffset] = useState(0);
  const [realTime, setRealTime] = useState(Date.now());
  const [connectionError, setConnectionError] = useState("");
  const selectedRoom = rooms.find((room) => room.roomId === selectedRoomId);
  const roomCode = selectedRoom?.id ?? "";

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
    const mapped = response.rooms.map((room) => ({
      id: room.code, roomId: room.roomId ?? room.code, legacyCode: room.legacyCode, name: room.name, avatarUrl: room.avatarUrl,
    }));
    const rememberedId = window.localStorage.getItem(ROOM_ID_STORAGE_KEY);
    const rememberedCode = window.localStorage.getItem(ROOM_CODE_STORAGE_KEY);
    setRooms(mapped);
    setConnectionError("");
    setSelectedRoomId((current) => {
      const id = current || rememberedId;
      if (id) {
        const room = mapped.find((room) => room.roomId === id);
        if (room) return room.roomId;
        return (mapped.find((room) => room.id === rememberedCode) ?? mapped.at(-1))?.roomId ?? "";
      }
      const room = mapped.find((room) => room.legacyCode && room.legacyCode === rememberedCode)
        ?? mapped.find((room) => room.id === rememberedCode) ?? mapped[0];
      return room?.roomId ?? "";
    });
  }, []);

  useEffect(() => {
    if (roomCode && selectedRoomId) {
      window.localStorage.setItem(ROOM_ID_STORAGE_KEY, selectedRoomId);
      window.localStorage.setItem(ROOM_CODE_STORAGE_KEY, roomCode);
    }
  }, [roomCode, selectedRoomId]);

  const refreshDisplay = useCallback(async (code, roomId) => {
    if (!code) return;
    try {
      const response = await api(`/api/v1/rooms/${encodeURIComponent(code)}/display`);
      const responseRoomId = response.room.roomId ?? response.room.code;
      if (responseRoomId !== roomId) {
        loadRooms().catch(() => setConnectionError("正在同步直播间列表…"));
        return;
      }
      const receivedAt = Date.now();
      const scheduleDate = dateKey(new Date(response.serverNow));
      setDisplayData((current) => {
        if (current?.room?.roomId === responseRoomId && current.room.id === response.room.code &&
            current.dataUpdatedAt === response.dataUpdatedAt && current.scheduleDate === scheduleDate) {
          return { ...current, nextTransitionAt: response.nextTransitionAt };
        }
        return {
          room: { id: response.room.code, roomId: responseRoomId, name: response.room.name },
          schedule: response.schedule,
          directorShifts: response.directorShifts,
          assistantShifts: response.assistantShifts,
          scheduleDate,
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
        setDisplayData((current) => current?.room?.roomId === roomId ? null : current);
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
    if (!roomCode || user?.role !== "viewer") return undefined;
    const update = () => refreshDisplay(roomCode, selectedRoomId);
    update();
    const poll = window.setInterval(update, 30_000);
    const onReturn = () => { if (document.visibilityState === "visible") update(); };
    window.addEventListener("online", update);
    document.addEventListener("visibilitychange", onReturn);
    return () => {
      window.clearInterval(poll);
      window.removeEventListener("online", update);
      document.removeEventListener("visibilitychange", onReturn);
    };
  }, [user, roomCode, selectedRoomId, refreshDisplay]);

  useEffect(() => {
    if (!roomCode || user?.role !== "viewer" || !displayData?.nextTransitionAt) return undefined;
    const boundaryDelay = Math.max(250, displayData.nextTransitionAt - (Date.now() + serverOffset) + 100);
    if (boundaryDelay >= 30_000) return undefined;
    const boundary = window.setTimeout(() => refreshDisplay(roomCode, selectedRoomId), boundaryDelay);
    return () => window.clearTimeout(boundary);
  }, [user, roomCode, selectedRoomId, displayData?.nextTransitionAt, serverOffset, refreshDisplay]);

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

  function chooseRoom(nextCode) {
    const next = rooms.find((room) => room.id === nextCode);
    if (!next || next.roomId === selectedRoomId) return;
    setSelectedRoomId(next.roomId);
    setDisplayData(null);
  }

  const timestamp = realTime + serverOffset;
  const room = useMemo(() => {
    if (!selectedRoom) return null;
    const current = displayData?.room?.roomId === selectedRoom.roomId;
    return {
      ...selectedRoom,
      schedule: current ? displayData.schedule : [],
      directorShifts: current ? displayData.directorShifts : [],
      assistantShifts: current ? displayData.assistantShifts : [],
    };
  }, [selectedRoom, displayData]);
  const program = useMemo(() => getProgram(room?.schedule, timestamp), [room, timestamp]);
  const directorProgram = useMemo(() => getProgram(room?.directorShifts, timestamp), [room, timestamp]);
  const assistantProgram = useMemo(() => getProgram(room?.assistantShifts, timestamp), [room, timestamp]);
  const displayed = program.display;
  const displayedDirector = directorProgram.display;
  const displayedAssistant = assistantProgram.display;
  const isLive = Boolean(program.current);
  const nowDate = new Date(timestamp);
  const statusText = isLive ? "当前直播" : displayed ? "下一场排班" : displayedDirector ? "导演已排班" : displayedAssistant ? "助播已排班" : "暂无排班";

  if (authLoading) return <div className="system-loading"><div className="loading-orbit" /><span>正在连接展示系统</span></div>;
  if (!user) return <LoginPage onLogin={login} theme={theme} onToggleTheme={toggleTheme} />;
  if (user.role === "admin") return <AdminPage user={user} csrfToken={csrfToken} onLogout={logout} theme={theme} onToggleTheme={toggleTheme} />;

  return (
    <div className="app-shell">
      <header className="topbar">
        <Brand />
        <DisplayRoomPicker rooms={rooms} value={roomCode} onChange={chooseRoom} />
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
              <div><div className="section-kicker">TODAY</div><h2>主播排班</h2></div>
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
              <div className="empty-schedule">{rooms.length ? "所选直播间今日暂无主播排班。" : "管理员尚未上传直播间排班。"}</div>
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
              <h1>{room?.name ?? "等待直播间信息"}</h1>
              <div className="stage-period"><div className="stage-date">{formatDate(nowDate)}</div><div className="time-strip"><span className="time-strip-label">{isLive ? "主播时段" : displayed ? "下一主播时段" : "主播排班"}</span><span className="time-strip-range">{formatRange(displayed)}</span></div></div>
            </div>
            <div className="portrait-frame">
              {displayed?.photo ? <img src={displayed.photo} alt={`${displayed.host || "本场"} 主播照片`} /> : <div className="portrait-empty"><span>本场尚未添加</span><span>主播照片</span></div>}
            </div>
            {displayed || displayedDirector || displayedAssistant ? (
              <div className="role-grid">
                <RoleCard label="导演" value={displayedDirector?.director} time={displayedDirector ? `${directorProgram.current ? "当前" : "下一场"} · ${formatRange(displayedDirector)}` : "暂无导演排班"} />
                <RoleCard label="主播" value={displayed?.host} time={displayed ? `${program.current ? "当前" : "下一场"} · ${formatRange(displayed)}` : "暂无主播排班"} featured />
                <RoleCard label="助播" value={displayedAssistant?.assistant} time={displayedAssistant ? `${assistantProgram.current ? "当前" : "下一场"} · ${formatRange(displayedAssistant)}` : "暂无助播排班"} />
              </div>
            ) : <div className="no-session">{room ? "当前没有可展示的排班" : "等待管理员上传直播间排班"}</div>}
          </div>
          <MerchandisingInfo products={displayed?.featuredProducts} salesTarget={displayed?.salesTarget} />
        </section>
      </main>
    </div>
  );
}
