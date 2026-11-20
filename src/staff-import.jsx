import { useEffect, useRef, useState } from "react";

function DateRange({ summary }) {
  return summary.firstDate === summary.lastDate
    ? summary.firstDate
    : <>{summary.firstDate} 至 {summary.lastDate}</>;
}

function ImportIssues({ errors, warnings }) {
  return [
    { items: errors, label: "需要修正", className: "issue-list" },
    { items: warnings, label: "跳过提示", className: "warning-list" },
  ].map(({ items, label, className }) => items.length > 0 && (
    <details className={className + " staff-issues"} key={label} open={className === "issue-list" || undefined}>
      <summary>{label}（{items.length}）</summary>
      <ul>
        {items.map((item, index) => (
          <li key={index}>
            {[item.sheet, item.row && "第 " + item.row + " 行", item.column && item.column + " 列", item.room, item.date, item.field]
              .filter(Boolean).join(" · ")}：{item.message}
          </li>
        ))}
      </ul>
    </details>
  ));
}

function ShiftDetails({ label, shifts, previous }) {
  return (
    <div className="staff-shifts">
      <h4>{label}排班</h4>
      {shifts.length > 0 ? (
        <ul>
          {shifts.map((shift) => (
            <li key={shift.start + "-" + shift.end}>
              <time>{shift.start}–{shift.overnight && "次日 "}{shift.end}</time>
              <strong>{shift.person}</strong>
              <small>{shift.sourceSheet} 第 {shift.sourceRow} 行</small>
              {shift.featuredProducts?.length > 0 && (
                <span className="staff-shift-merch"><small>主推商品</small> <span>{shift.featuredProducts.join("、")}</span></span>
              )}
              {shift.salesTarget && (
                <span className="staff-shift-merch"><small>目标销售额</small> <span>{shift.salesTarget}</span></span>
              )}
            </li>
          ))}
        </ul>
      ) : <p>{previous ? "当天" + label + "排班将清空" : "当天无" + label + "排班"}</p>}
    </div>
  );
}

function ImportPreview({ preview }) {
  const { summary } = preview;
  return (
    <section className="upload-preview" aria-label="排班导入预览">
      <h3>导入预览</h3>
      <p>确认后，以下房间和日期的主播与导演排班会整体替换。</p>
      <div className="import-summary">
        <span><strong>{summary.roomCount}</strong> 个直播间</span>
        <span><DateRange summary={summary} /></span>
        <span><strong>{summary.dateCount}</strong> 个房间日期组合</span>
        <span>主播 <strong>{summary.scheduleCount}</strong> 场</span>
        <span>导演 <strong>{summary.directorShiftCount}</strong> 班</span>
        {summary.skippedCount > 0 && <span>跳过 <strong>{summary.skippedCount}</strong> 项</span>}
      </div>
      <div className="staff-preview-rooms">
        {preview.rooms.map((room) => (
          <section className="staff-preview-room" key={room.code}>
            <h4>{room.code} 号 · {room.name}{room.isNew && <small>首次录入</small>}</h4>
            {room.name !== room.sourceName && <p>表内名称：{room.sourceName}</p>}
            {room.dates.map((day) => (
              <details className="staff-import-day" key={day.date}>
                <summary>
                  <span>{day.date}</span>
                  <span>主播 {day.previousHostCount} → {day.hostShifts.length} 场</span>
                  <span>导演 {day.previousDirectorCount} → {day.directorShifts.length} 班</span>
                  {day.previousHostCount > 0 && day.hostShifts.length === 0 && <strong>将清空主播</strong>}
                  {day.previousDirectorCount > 0 && day.directorShifts.length === 0 && <strong>将清空导演</strong>}
                </summary>
                <div className="staff-shift-grid">
                  <ShiftDetails label="主播" shifts={day.hostShifts} previous={day.previousHostCount} />
                  <ShiftDetails label="导演" shifts={day.directorShifts} previous={day.previousDirectorCount} />
                </div>
              </details>
            ))}
          </section>
        ))}
      </div>
    </section>
  );
}

function RoomMatches({ sheet, assignments, onSelect, errors, busy }) {
  return (
    <section className="staff-room-matches" aria-label="匹配直播间">
      <h3>匹配直播间</h3>
      <p>请为表内的新名称选择对应直播间。确认导入后会记住此次匹配。</p>
      {sheet.sourceRooms.map((room) => (
        <label key={room.sourceRoomKey} className="staff-room-match">
          <span><strong>{room.name}</strong><small>{room.sheet} 第 {room.row} 行 · {room.dateCount} 天</small></span>
          {room.automatic ? (
            <span>已匹配 · {room.code} 号</span>
          ) : (
            <select value={assignments[room.sourceRoomKey] ?? ""} disabled={busy}
              aria-invalid={errors.some((issue) => issue.room === room.name) || undefined}
              onChange={(event) => onSelect(room.sourceRoomKey, event.target.value)}>
              <option value="">请选择直播间</option>
              {sheet.roomOptions.map(({ code, name }) => (
                <option value={code} key={code}>{code} 号 · {name ?? "未录入"}</option>
              ))}
            </select>
          )}
        </label>
      ))}
    </section>
  );
}

export function StaffScheduleImport({ api, csrfToken, onViewRecords, hidden }) {
  const input = useRef(null);
  const request = useRef(null);
  const [file, setFile] = useState(null);
  const [sheet, setSheet] = useState(null);
  const [assignments, setAssignments] = useState(() => Object.create(null));
  const [preview, setPreview] = useState(null);
  const [result, setResult] = useState(null);
  const [warnings, setWarnings] = useState([]);
  const [errors, setErrors] = useState([]);
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const [failed, setFailed] = useState(false);

  useEffect(() => () => request.current?.abort(), []);

  function clearFeedback() {
    setMessage("");
    setErrors([]);
    setFailed(false);
  }

  function resetFile(next) {
    request.current?.abort();
    setFile(next);
    if (!next && input.current) input.current.value = "";
    setSheet(null);
    setAssignments(Object.create(null));
    setPreview(null);
    setResult(null);
    setWarnings([]);
    clearFeedback();
  }

  function selectFile(next) {
    if (next && (!/\.xlsx$/i.test(next.name) || next.size === 0 || next.size > 30 * 1024 * 1024)) {
      resetFile(null);
      setFailed(true);
      setMessage("请选择非空、大小不超过 30 MB 的 .xlsx 排班表。");
      return;
    }
    resetFile(next);
  }

  function changeAssignment(key, code) {
    setAssignments((current) => Object.assign(Object.create(null), current, { [key]: code }));
    setPreview(null);
    clearFeedback();
  }

  const selectedCodes = sheet?.sourceRooms.map((room) => room.automatic ? room.code : assignments[room.sourceRoomKey]) ?? [];
  const allChosen = selectedCodes.every(Boolean);
  const duplicate = selectedCodes.some((code, index) => code && selectedCodes.indexOf(code) !== index);

  async function upload(action) {
    if (request.current || !file) return;
    if (action === "commit" && !preview) return;
    if (action === "preview" && (!allChosen || duplicate)) return;
    const controller = new AbortController();
    request.current = controller;
    setBusy(action);
    clearFeedback();
    const headers = { "x-csrf-token": csrfToken };
    let body;
    if (action === "commit") {
      headers["content-type"] = "application/json";
      body = JSON.stringify({ previewId: preview.previewId });
    } else {
      setPreview(null);
      body = new FormData();
      body.append("file", file);
      body.append("roomBindings", JSON.stringify(Object.fromEntries(Object.entries(assignments).filter(([, code]) => code))));
    }

    try {
      const response = await api("/api/v1/admin/schedule-upload?action=" + action + "&mode=room-name", {
        method: "POST", headers, body, signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      if (action === "commit") {
        setResult(response);
        setPreview(null);
        setSheet(null);
        return;
      }
      setSheet(response);
      setWarnings(response.warnings ?? []);
      setPreview(response.status === "ready" ? response : null);
    } catch (cause) {
      if (controller.signal.aborted) return;
      setFailed(true);
      if (action === "commit" && (!cause.status || cause.status >= 500)) {
        setMessage("暂未收到导入结果，请再次点击「确认导入」查询或完成本次导入。");
      } else {
        setPreview(null);
        if (action === "preview") {
          setErrors(cause.body?.errors ?? []);
          setWarnings(cause.body?.warnings ?? []);
          if (cause.body?.sourceRooms) {
            setSheet(cause.body);
            const editable = new Set(cause.body.sourceRooms.filter((room) => !room.automatic).map((room) => room.sourceRoomKey));
            setAssignments((current) => Object.assign(Object.create(null),
              Object.fromEntries(Object.entries(current).filter(([key]) => editable.has(key)))));
          }
        }
        setMessage(cause.body?.errors?.length ? "请修正以下问题后重新校验。" : cause.message || "请求失败，请重试。");
      }
    } finally {
      if (request.current === controller) {
        request.current = null;
        setBusy("");
      }
    }
  }

  const needsMatching = sheet?.sourceRooms.some((room) => !room.automatic);
  return (
    <section className="admin-card" role="tabpanel" hidden={hidden}>
      <div className="admin-card-heading">
        <div className="admin-icon" aria-hidden="true">↥</div>
        <div><h2>导入员工排班表</h2><p>按直播间名称和日期导入。主推商品用逗号分隔，目标销售额按原文展示。</p></div>
      </div>
      {!result && (
        <form className={"upload-form staff-import-form" + (!preview && needsMatching ? " staff-matching-active" : "")}
          onSubmit={(event) => { event.preventDefault(); upload("preview"); }}>
          <label className={"upload-dropzone" + (file ? " upload-selected" : "")} htmlFor="staff-workbook">
            <span className="upload-glyph" aria-hidden="true">⌁</span>
            <strong>{file ? file.name : "选择员工排班表"}</strong>
            <small>{file ? (file.size / 1024 / 1024).toFixed(2) + " MB · 点击更换" : ".xlsx，最大 30 MB"}</small>
          </label>
          <input className="staff-file-input" id="staff-workbook" ref={input} type="file"
            accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            aria-label="选择员工排班表" disabled={Boolean(busy)}
            onChange={(event) => selectFile(event.target.files?.[0] ?? null)} />
          {!preview && needsMatching && (
            <RoomMatches sheet={sheet} assignments={assignments} onSelect={changeAssignment} errors={errors} busy={busy} />
          )}
          {!preview && <button className="button-primary upload-button" type="submit"
            disabled={!file || Boolean(busy) || !allChosen || duplicate}>
            {busy === "preview" ? "正在读取排班表…" : needsMatching ? "生成预览" : "校验并预览"}
          </button>}
        </form>
      )}
      {duplicate && !preview && <div role="alert" className="form-message form-error">每个表内名称需选择不同的直播间编号。</div>}
      {message && <div role={failed ? "alert" : "status"} className={"form-message" + (failed ? " form-error" : "")}>{message}</div>}
      {preview && <ImportPreview preview={preview} />}
      <ImportIssues errors={errors} warnings={warnings} />
      {preview && (
        <div className="upload-preview-actions">
          {needsMatching && <button className="avatar-secondary-button" type="button" disabled={Boolean(busy)}
            onClick={() => { setPreview(null); clearFeedback(); }}>返回修改匹配</button>}
          <button className="avatar-secondary-button" type="button" disabled={Boolean(busy)} onClick={() => resetFile(null)}>取消</button>
          <button className="button-primary upload-button" type="button" disabled={Boolean(busy)} onClick={() => upload("commit")}>
            {busy === "commit" ? "正在导入…" : "确认导入"}
          </button>
        </div>
      )}
      {result && (
        <div role="status" className="form-message form-success staff-import-success">
          已导入 {result.roomCount} 个直播间（<DateRange summary={result} />），共 {result.scheduleCount} 场主播、{result.directorShiftCount} 班导演。
          <div className="upload-preview-actions">
            <button className="avatar-secondary-button" type="button" onClick={() => resetFile(null)}>继续导入</button>
            <button className="button-primary upload-button" type="button" onClick={onViewRecords}>查看已录入排班</button>
          </div>
        </div>
      )}
    </section>
  );
}
