import { useEffect, useRef, useState } from "react";

function RoomAvatar({ room }) {
  const [failedUrl, setFailedUrl] = useState("");
  const url = room.avatarUrl;
  return (
    <span className="room-avatar" aria-hidden="true">
      {url && url !== failedUrl
        ? <img src={url} alt="" onError={() => setFailedUrl(url)} />
        : room.code ?? room.id}
    </span>
  );
}

function RoomPickerLabel({ room }) {
  return (
    <>
      <RoomAvatar room={room} />
      <span className="room-picker-name">{room.id}号直播间 · {room.name}</span>
    </>
  );
}

export function DisplayRoomPicker({ rooms, value, onChange }) {
  const picker = useRef(null);
  const selected = rooms.find((room) => room.id === value) ?? rooms[0];

  useEffect(() => {
    function closeOutside(event) {
      if (picker.current && !picker.current.contains(event.target)) picker.current.open = false;
    }
    document.addEventListener("pointerdown", closeOutside);
    return () => document.removeEventListener("pointerdown", closeOutside);
  }, []);

  function closePicker() {
    const details = picker.current;
    details.open = false;
    details.querySelector("summary").focus();
  }

  function handleKeys(event) {
    const details = event.currentTarget;
    if (event.key === "Escape" && details.open) {
      event.preventDefault();
      closePicker();
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    if (!details.open && (event.key === "Home" || event.key === "End")) return;
    event.preventDefault();
    details.open = true;
    const options = [...details.querySelectorAll(".room-picker-option")];
    const focused = options.indexOf(event.target);
    if (event.key === "Home") options[0]?.focus();
    else if (event.key === "End") options.at(-1)?.focus();
    else if (focused < 0) options.find((item) => item.getAttribute("aria-current") === "true")?.focus();
    else options[Math.min(options.length - 1, Math.max(0, focused + (event.key === "ArrowUp" ? -1 : 1)))]?.focus();
  }

  return (
    <div className="room-selector-inline">
      <span className="room-picker-label">直播间</span>
      {selected ? (
        <details className="room-picker" ref={picker} onKeyDown={handleKeys}
          onBlur={(event) => {
            if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) event.currentTarget.open = false;
          }}>
          <summary className="room-picker-trigger" title={selected.name}><RoomPickerLabel room={selected} /></summary>
          <div className="room-picker-menu" role="group" aria-label="选择直播间">
            {rooms.map((room) => (
              <button type="button" className="room-picker-option" key={room.id} title={room.name}
                aria-current={selected.id === room.id ? "true" : undefined}
                onClick={() => { onChange(room.id); closePicker(); }}>
                <RoomPickerLabel room={room} />
              </button>
            ))}
          </div>
        </details>
      ) : <span className="room-picker room-picker-trigger room-picker-empty">暂无直播间</span>}
    </div>
  );
}

export function RoomManagement({ api, csrfToken }) {
  const [data, setData] = useState(null);
  const [editing, setEditing] = useState(null);
  const [merging, setMerging] = useState(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null);
  const fileInput = useRef(null);
  const uploadTarget = useRef(null);
  const listPath = "/api/v1/admin/rooms";

  useEffect(() => {
    const controller = new AbortController();
    api(listPath, { signal: controller.signal }).then(setData).catch((cause) => {
      if (!controller.signal.aborted) setMessage({ error: true, text: cause.message });
    });
    return () => controller.abort();
  }, [api]);

  async function changeRoom(room, { method, resource = "", body, contentType, success }) {
    if (busy || !data) return;
    setBusy(true);
    setMessage(null);
    const path = listPath + "/" + encodeURIComponent(room.code) + resource;
    const headers = { "x-csrf-token": csrfToken, "if-match": JSON.stringify(data.dataUpdatedAt) };
    if (contentType) headers["content-type"] = contentType;
    try {
      setData(await api(path, { method, headers, body }));
      if (resource !== "/avatar") {
        setEditing(null);
        setMerging(null);
      }
      setMessage({ error: false, text: success });
    } catch (cause) {
      setMessage({ error: true, text: cause.message });
      if (cause.body?.error?.code === "ROOMS_CHANGED" || cause.status === 404) {
        try {
          setData(await api(listPath));
          setEditing(null);
          setMerging(null);
        } catch {}
      }
    } finally {
      setBusy(false);
    }
  }

  function saveName(event, room) {
    event.preventDefault();
    const name = editing?.name.trim();
    if (!name || name === room.name) return;
    changeRoom(room, {
      method: "PATCH", contentType: "application/json", body: JSON.stringify({ name }), success: "已保存直播间名称。",
    });
  }

  function selectAvatar(event) {
    const file = event.target.files?.[0];
    const room = uploadTarget.current;
    event.target.value = "";
    if (!file || !room) return;
    if (!/\.(?:jpe?g|png)$/i.test(file.name) || file.size > 8 * 1024 * 1024 || !file.size) {
      setMessage({ error: true, text: "请选择不超过 8 MB 的 JPG 或 PNG 图片。" });
      return;
    }
    changeRoom(room, { method: "PUT", resource: "/avatar", body: file, success: "已保存直播间头像。" });
  }

  function deleteRoom(room) {
    const confirmed = window.confirm(
      `删除 ${room.code} 号直播间「${room.name}」？\n\n将永久删除该直播间的头像、${room.scheduleCount} 场主播排班和 ${room.directorShiftCount} 班导演排班。`,
    );
    if (confirmed) changeRoom(room, { method: "DELETE", success: "已删除直播间。" });
  }

  function confirmMerge(event, room) {
    event.preventDefault();
    if (!merging?.targetCode) return;
    const { targetCode } = merging;
    if (!window.confirm(`保留 ${targetCode} 号「${room.name}」？\n\n${room.code} 号的 ${room.scheduleCount} 场主播排班和 ${room.directorShiftCount} 班导演排班将并入 ${targetCode} 号，完成后列表只显示保留的编号。`)) return;
    changeRoom(room, {
      method: "POST", resource: "/merge", contentType: "application/json",
      body: JSON.stringify({ targetCode }), success: `已合并到 ${targetCode} 号直播间。`,
    });
  }

  return (
    <section className="admin-card room-management" id="room-management-panel" role="tabpanel" aria-labelledby="room-management-tab">
      <div className="admin-card-heading">
        <div><h2>直播间管理</h2><p>直播间头像会显示在展示端的直播间选择器中。</p></div>
      </div>
      <input ref={fileInput} type="file" accept=".jpg,.jpeg,.png,image/jpeg,image/png" onChange={selectAvatar} hidden />
      {message && <p className={"form-message" + (message.error ? " form-error" : "")} role={message.error ? "alert" : "status"}>{message.text}</p>}
      {data?.rooms.length > 0 ? (
        <ul className="room-management-list">
          {data.rooms.map((room) => {
            const targets = (data.duplicateGroups?.find((codes) => codes.includes(room.code)) ?? []).filter((code) => code !== room.code);
            return (
              <li className="room-management-row" key={room.code}>
                <div className="room-management-identity">
                  <RoomAvatar room={room} />
                  <div>
                    <h3>{room.code} 号 · {room.name}</h3>
                    <p>{room.scheduleCount} 场主播 · {room.directorShiftCount} 班导演</p>
                  </div>
                </div>
                <div className="room-management-actions">
                  <button type="button" className="avatar-secondary-button" disabled={busy}
                    onClick={() => { setEditing({ code: room.code, name: room.name }); setMerging(null); setMessage(null); }}>改名</button>
                  <button type="button" className="avatar-secondary-button" disabled={busy}
                    onClick={() => { uploadTarget.current = room; fileInput.current.click(); }}>
                    {room.avatarUrl ? "更换头像" : "添加直播间头像"}
                  </button>
                  {room.avatarUrl && (
                    <button type="button" className="avatar-text-button" disabled={busy}
                      onClick={() => changeRoom(room, { method: "DELETE", resource: "/avatar", success: "已恢复默认头像。" })}>恢复默认头像</button>
                  )}
                  {targets.length > 0 && (
                    <button type="button" className="avatar-secondary-button" disabled={busy}
                      onClick={() => { setMerging({ code: room.code, targetCode: "" }); setEditing(null); setMessage(null); }}>合并重名直播间</button>
                  )}
                  <button type="button" className="avatar-text-button danger" disabled={busy} onClick={() => deleteRoom(room)}>
                    删除直播间
                  </button>
                </div>
                {editing?.code === room.code && (
                  <form className="room-management-form" onSubmit={(event) => saveName(event, room)}>
                    <label>直播间名称
                      <input autoFocus maxLength={120} required value={editing.name} disabled={busy}
                        onChange={(event) => setEditing({ code: room.code, name: event.target.value })} />
                    </label>
                    <button type="submit" className="button-primary avatar-choose-button"
                      disabled={busy || !editing.name.trim() || editing.name.trim() === room.name}>保存名称</button>
                    <button type="button" className="avatar-secondary-button" disabled={busy} onClick={() => setEditing(null)}>取消</button>
                  </form>
                )}
                {merging?.code === room.code && (
                  <form className="room-management-form" onSubmit={(event) => confirmMerge(event, room)}>
                    <label>要保留的直播间编号
                      <select autoFocus required value={merging.targetCode} disabled={busy}
                        onChange={(event) => setMerging({ code: room.code, targetCode: event.target.value })}>
                        <option value="">请选择</option>
                        {targets.map((code) => <option key={code} value={code}>{code} 号</option>)}
                      </select>
                    </label>
                    <button type="submit" className="button-primary avatar-choose-button" disabled={busy || !merging.targetCode}>确认合并</button>
                    <button type="button" className="avatar-secondary-button" disabled={busy} onClick={() => setMerging(null)}>取消</button>
                  </form>
                )}
              </li>
            );
          })}
        </ul>
      ) : data ? <div className="avatar-empty">暂无直播间。导入排班后可在这里管理。</div>
        : !message && <div className="avatar-empty">正在读取直播间…</div>}
    </section>
  );
}
