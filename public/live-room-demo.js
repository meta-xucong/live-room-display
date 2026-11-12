(() => {
  const rooms = window.LIVE_ROOMS || [];
  const state = {
    roomId: rooms[0]?.id ?? "",
    clockMode: "preview",
    previewAt: rooms[0]?.defaultPreview ?? "",
    playing: false,
    realTime: Date.now(),
  };
  const root = document.getElementById("root");

  function updateFullscreenLayout() {
    const availableHeight = window.screen?.availHeight || window.screen?.height || 0;
    const isFullscreenViewport = window.innerWidth >= 1100
      && availableHeight > 0
      && window.innerHeight / availableHeight >= 0.94;
    document.documentElement.classList.toggle("fullscreen-layout", isFullscreenViewport);
  }
  updateFullscreenLayout();
  window.addEventListener("resize", updateFullscreenLayout);

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (character) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    })[character]);
  }

  function dateKey(date) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  }

  function inputDate(date) {
    return `${dateKey(date)}T${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  }

  function atTime(date, time) {
    const [hour, minute] = time.split(":").map(Number);
    const result = new Date(`${date}T00:00:00`);
    result.setHours(hour, minute, 0, 0);
    return result.getTime();
  }

  function getProgram(room, timestamp) {
    const todayKey = dateKey(new Date(timestamp));
    const yesterdayDate = new Date(timestamp);
    yesterdayDate.setDate(yesterdayDate.getDate() - 1);
    const yesterdayKey = dateKey(yesterdayDate);
    const sessions = room.schedule
      .filter((item) => item.date === todayKey || item.date === yesterdayKey)
      .map((item) => {
        const startAt = atTime(item.date, item.start);
        let endAt = atTime(item.date, item.end);
        if (endAt <= startAt) endAt += 86_400_000;
        return { ...item, startAt, endAt };
      })
      .sort((left, right) => left.startAt - right.startAt);
    const current = sessions.find((item) => item.startAt <= timestamp && timestamp < item.endAt) ?? null;
    const next = sessions.find((item) => item.startAt > timestamp) ?? null;
    return {
      current,
      next,
      display: current ?? next,
      today: room.schedule.filter((item) => item.date === todayKey),
      nextChangeAt: current ? Math.min(current.endAt, next?.startAt ?? current.endAt) : next?.startAt ?? null,
    };
  }

  function formatDate(date) {
    return new Intl.DateTimeFormat("zh-CN", {
      year: "numeric", month: "long", day: "numeric", weekday: "long",
    }).format(date);
  }

  function formatClock(date) {
    return new Intl.DateTimeFormat("zh-CN", {
      hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
    }).format(date);
  }

  function formatRange(item) {
    return item ? `${item.start}–${item.end}` : "—";
  }

  function roleCard(label, name, featured) {
    return `<section class="role-card${featured ? " role-card-featured" : ""}"><div class="role-label">${label}</div><div class="role-name">${escapeHtml(name || "待安排")}</div></section>`;
  }

  function merchandisingInfo(products, salesTarget) {
    const items = Array.isArray(products) ? products.filter(Boolean) : [];
    const list = items.length
      ? `<ol class="product-list">${items.map((product, index) => `<li><span class="product-index">${String(index + 1).padStart(2, "0")}</span><span class="product-name">${escapeHtml(product)}</span></li>`).join("")}</ol>`
      : `<div class="merch-empty">暂未配置主推商品</div>`;
    return `<div class="merch-row"><section class="merch-card products-card" aria-label="主推商品"><div class="merch-heading"><div><span class="merch-kicker">FEATURED</span><h2>主推商品</h2></div><span class="product-count">${items.length} 款</span></div>${list}</section><section class="merch-card target-card" aria-label="目标销售额"><span class="merch-kicker">SALES TARGET</span><span class="target-label">目标销售额</span><strong class="target-value">${escapeHtml(salesTarget || "待设置")}</strong></section></div>`;
  }

  function render() {
    const room = rooms.find((item) => item.id === state.roomId) ?? rooms[0];
    if (!room) return;
    const timestamp = state.clockMode === "live" ? state.realTime : new Date(state.previewAt).getTime();
    const program = getProgram(room, timestamp);
    const displayed = program.display;
    const isLive = Boolean(program.current);
    const nowDate = new Date(timestamp);
    const statusText = isLive ? "当前直播" : displayed ? "下一场排班" : "暂无排班";
    const options = rooms.map((item) => `<option value="${escapeHtml(item.id)}"${item.id === room.id ? " selected" : ""}>${escapeHtml(item.id)}号直播间 · ${escapeHtml(item.name)}</option>`).join("");
    const scheduleRows = program.today.map((item) => {
      const active = program.current?.date === item.date && program.current?.start === item.start && program.current?.end === item.end;
      const next = program.next?.date === item.date && program.next?.start === item.start && program.next?.end === item.end;
      return `<li class="schedule-item${active ? " schedule-active" : ""}${next ? " schedule-next" : ""}"><span class="schedule-marker"></span><div class="schedule-copy"><div class="schedule-time">${escapeHtml(formatRange(item))}</div><div class="schedule-host">${escapeHtml(item.host || "主播待安排")}</div></div><span class="schedule-state">${active ? "当前" : next ? "下一场" : ""}</span></li>`;
    }).join("");
    const roles = displayed
      ? `<div class="role-grid">${roleCard("导演", displayed.director, false)}${roleCard("主播", displayed.host, true)}${roleCard("助播", displayed.assistant, false)}</div>`
      : `<div class="no-session">当前没有可展示的排班</div>`;
    const merchandise = merchandisingInfo(displayed?.featuredProducts, displayed?.salesTarget);
    const portrait = displayed?.photo
      ? `<img src="${escapeHtml(displayed.photo)}" alt="${escapeHtml(displayed.host)} 主播照片">`
      : `<div class="portrait-empty"><span>本场尚未添加</span><span>主播照片</span></div>`;
    const clockControls = state.clockMode === "preview"
      ? `<label class="control-label" for="preview-time">预览日期和时间</label><input id="preview-time" type="datetime-local" value="${escapeHtml(state.previewAt)}"><div class="clock-actions"><button class="button-primary" type="button" data-action="toggle-play">${state.playing ? "暂停演示" : "快进演示 ×60"}</button><button class="button-quiet" type="button" data-action="use-live">使用实时时钟</button></div><div class="small-note">快进模式每秒前进一分钟，到排班边界自动换场。</div>`
      : `<div class="clock-actions live-actions"><button class="button-quiet" type="button" data-action="use-preview">返回演示时间</button></div>`;

    root.innerHTML = `<div class="app-shell">
      <header class="topbar"><div><div class="brand-kicker">STUDIO DISPLAY</div><div class="brand-title">直播间信息牌</div></div><div class="room-selector-inline"><label for="room-select">直播间</label><select id="room-select">${options}</select></div><div class="topbar-right"><span class="refresh-indicator"></span><span>按排班自动切换</span><span class="topbar-divider"></span><span>实时校时 · 1 秒</span></div></header>
      <main class="workspace">
        <aside class="control-column">
          <section class="control-card clock-card"><div class="section-heading"><div><div class="section-kicker">CLOCK</div><h2>时间预览</h2></div><span class="mode-pill${state.clockMode === "live" ? " mode-live" : ""}">${state.clockMode === "live" ? "实时" : "演示"}</span></div><div class="clock-current">${formatClock(nowDate)}</div><div class="clock-date">${formatDate(nowDate)}</div>${clockControls}</section>
          <section class="control-card schedule-card"><div class="section-heading schedule-heading"><div><div class="section-kicker">TODAY</div><h2>当日排班</h2></div><span class="schedule-count">${program.today.length} 场</span></div>${program.today.length ? `<ol class="schedule-list">${scheduleRows}</ol>` : `<div class="empty-schedule">所选日期没有排班。</div>`}</section>
        </aside>
        <section class="display-stage" aria-label="直播间门口电子屏预览">
          <div class="stage-topline"><span>直播间现场信息</span><span class="live-pill${isLive ? " live-pill-on" : " live-pill-next"}"><span class="live-dot"></span>${statusText}</span></div>
          <div class="stage-main"><div class="stage-copy"><div class="room-heading"><div class="room-id-line">${escapeHtml(room.id)}<span>号直播间</span></div><h1>${escapeHtml(room.name)}</h1></div><div class="stage-period"><div class="stage-date">${formatDate(nowDate)}</div><div class="time-strip"><span class="time-strip-label">${isLive ? "当前时段" : displayed ? "即将开始" : "排班时段"}</span><span class="time-strip-range">${escapeHtml(formatRange(displayed))}</span></div></div></div><div class="portrait-frame">${portrait}</div>${roles}</div>
          ${merchandise}
        </section>
      </main>
    </div>`;
  }

  root.addEventListener("change", (event) => {
    if (event.target.id === "room-select") {
      const room = rooms.find((item) => item.id === event.target.value);
      if (room) {
        state.roomId = room.id;
        state.clockMode = "preview";
        state.previewAt = room.defaultPreview;
        state.playing = false;
        render();
      }
    }
    if (event.target.id === "preview-time" && event.target.value) {
      state.previewAt = event.target.value;
      state.playing = false;
      render();
    }
  });

  root.addEventListener("click", (event) => {
    const action = event.target.closest("[data-action]")?.dataset.action;
    if (!action) return;
    if (action === "toggle-play") state.playing = !state.playing;
    if (action === "use-live") {
      state.playing = false;
      state.clockMode = "live";
      state.realTime = Date.now();
    }
    if (action === "use-preview") state.clockMode = "preview";
    render();
  });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && state.clockMode === "live") {
      state.realTime = Date.now();
      render();
    }
  });

  render();
  window.setInterval(() => {
    if (state.clockMode === "live") {
      state.realTime = Date.now();
      render();
    } else if (state.playing) {
      state.previewAt = inputDate(new Date(new Date(state.previewAt).getTime() + 60_000));
      render();
    }
  }, 1000);
})();
