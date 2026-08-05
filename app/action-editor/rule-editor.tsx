"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { createClientId } from "@/lib/game/client-id";
import type { ClientMessage, ServerMessage } from "@/lib/game/protocol";
import type { ActionRule, ActionRuleLocationState, ActionRuleSnapshot, MapViewport } from "@/lib/game/types";

type FormState = {
  id: string; name: string; description: string; category: ActionRule["category"];
  targetKind: ActionRule["targetKind"]; durationSeconds: string; requirements: string; check: string;
  costs: string; success: string; failure: string; resultTemplate: string; adult: boolean;
  visibility: ActionRule["visibility"]; cooldownSeconds: string; effectDurationSeconds: string; version: number | null;
};
type CommandWithoutId = ClientMessage extends infer Message
  ? Message extends { requestId: string }
    ? Omit<Message, "requestId">
    : never
  : never;

const EMPTY_FORM: FormState = {
  id: "", name: "", description: "", category: "life", targetKind: "self", durationSeconds: "60",
  requirements: "{}", check: "{}", costs: "{}", success: "{}", failure: "{}",
  resultTemplate: "{name}完成了行动。", adult: false, visibility: "public", cooldownSeconds: "0",
  effectDurationSeconds: "0", version: null,
};

function toForm(action: ActionRule): FormState {
  return {
    id: action.id, name: action.name, description: action.description, category: action.category,
    targetKind: action.targetKind, durationSeconds: String(action.durationSeconds),
    requirements: JSON.stringify(action.requirements, null, 2), check: JSON.stringify(action.check, null, 2),
    costs: JSON.stringify(action.costs, null, 2), success: JSON.stringify(action.success, null, 2),
    failure: JSON.stringify(action.failure, null, 2), resultTemplate: action.resultTemplate,
    adult: action.adult, visibility: action.visibility, cooldownSeconds: String(action.cooldownSeconds),
    effectDurationSeconds: String(action.success.statusDurationSeconds ?? 0), version: action.version,
  };
}

function parseObject(value: string, label: string) {
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${label}必须是 JSON 对象。`);
  return parsed as Record<string, unknown>;
}

export default function ActionRuleEditor({ initialRules }: { initialRules: ActionRuleSnapshot }) {
  const [rules, setRules] = useState(initialRules);
  const [selectedId, setSelectedId] = useState(initialRules.actions[0]?.id ?? "");
  const [form, setForm] = useState<FormState>(() => initialRules.actions[0] ? toForm(initialRules.actions[0]) : EMPTY_FORM);
  const [query, setQuery] = useState("玄关");
  const [layerId, setLayerId] = useState(initialRules.layers[0]?.id ?? "world-root");
  const [locationResults, setLocationResults] = useState<MapViewport["locations"]>([]);
  const [locationState, setLocationState] = useState<ActionRuleLocationState | null>(null);
  const [facilityId, setFacilityId] = useState("");
  const [priority, setPriority] = useState("0");
  const [notice, setNotice] = useState("正在连接规则服务……");
  const [connected, setConnected] = useState(false);
  const [dirty, setDirty] = useState(false);
  const socketRef = useRef<WebSocket | null>(null);
  const selectedIdRef = useRef(selectedId);
  const formRef = useRef(form);
  const dirtyRef = useRef(false);

  useEffect(() => { formRef.current = form; }, [form]);

  const updateForm = (patch: Partial<FormState>) => {
    dirtyRef.current = true;
    setDirty(true);
    setForm((current) => ({ ...current, ...patch }));
  };

  useEffect(() => {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    let stopped = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    const connect = () => {
      if (stopped) return;
      const socket = new WebSocket(`${protocol}//${window.location.host}/ws`);
      socketRef.current = socket;
      socket.addEventListener("open", () => {
        setConnected(true);
        setNotice("规则服务已连接。");
        socket.send(JSON.stringify({ type: "rules.actions.list", requestId: createClientId() }));
      });
      socket.addEventListener("close", () => {
        if (socketRef.current === socket) socketRef.current = null;
        setConnected(false);
        if (!stopped) {
          setNotice("规则服务连接已断开，正在自动重连……");
          retryTimer = setTimeout(connect, 1000);
        }
      });
      socket.addEventListener("message", (event) => {
        const message = JSON.parse(event.data) as ServerMessage;
        if (message.type === "rules.actions.snapshot") {
          setRules(message.rules);
          const nextId = message.rules.actions.some((action) => action.id === selectedIdRef.current)
            ? selectedIdRef.current : message.rules.actions[0]?.id ?? "";
          selectedIdRef.current = nextId;
          setSelectedId(nextId);
          const nextAction = message.rules.actions.find((action) => action.id === nextId);
          if (nextAction && !dirtyRef.current) setForm(toForm(nextAction));
          if (dirtyRef.current) setNotice("远端规则已更新；当前保留本地草稿，请保存或重新载入。");
        }
        if (message.type === "rules.location.snapshot") setLocationState(message.state);
        if (message.type === "map.locations.result") setLocationResults(message.locations);
        if (message.type === "rules.invalidated" && socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: "rules.actions.list", requestId: createClientId() }));
        }
        if (message.type === "ack" && message.message) {
          dirtyRef.current = false;
          setDirty(false);
          setNotice(message.message);
        }
        if (message.type === "error") setNotice(message.message);
      });
    };
    connect();
    return () => {
      stopped = true;
      if (retryTimer) clearTimeout(retryTimer);
      socketRef.current?.close();
    };
  }, []);

  const send = (message: CommandWithoutId) => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) { setNotice("规则服务尚未连接。"); return; }
    socket.send(JSON.stringify({ ...message, requestId: createClientId() }));
  };

  const save = () => {
    try {
      const success = parseObject(form.success, "成功结果");
      const effectDurationSeconds = Number.parseInt(form.effectDurationSeconds, 10);
      if (effectDurationSeconds > 0) success.statusDurationSeconds = effectDurationSeconds;
      else delete success.statusDurationSeconds;
      const action = {
        name: form.name, description: form.description, category: form.category, targetKind: form.targetKind,
        durationSeconds: Number.parseInt(form.durationSeconds, 10), requirements: parseObject(form.requirements, "需求"),
        check: parseObject(form.check, "检定"), costs: parseObject(form.costs, "成本"),
        success, failure: parseObject(form.failure, "失败结果"),
        resultTemplate: form.resultTemplate, adult: form.adult, visibility: form.visibility,
        cooldownSeconds: Number.parseInt(form.cooldownSeconds, 10),
      };
      if (form.version === null) {
        const id = form.id.trim() || `custom-action-${createClientId()}`;
        send({ type: "rules.action.create", action: { ...action, id } });
        selectedIdRef.current = id;
        setSelectedId(id);
      } else {
        send({ type: "rules.action.update", actionId: form.id, expectedVersion: form.version, action });
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "JSON 格式错误。");
    }
  };

  return (
    <main className="rule-editor-shell">
      <header className="rule-editor-header">
        <div><p>共享规则 · 仅授权编辑者可修改</p><h1>行动规则设计工具</h1></div>
        <nav><Link href="/">返回游戏</Link><Link href="/map-editor">地图设计</Link></nav>
      </header>
      <div className={`rule-connection ${connected ? "online" : "offline"}`} role="status">{notice}</div>
      <div className="rule-editor-grid">
        <aside className="rule-list" aria-label="行动规则列表">
          <header><strong>行动模板</strong><button onClick={() => { selectedIdRef.current = ""; setSelectedId(""); dirtyRef.current = false; setDirty(false); setForm({ ...EMPTY_FORM, id: `custom-action-${createClientId()}` }); }}>新增</button></header>
          {rules.actions.map((action) => (
            <button key={action.id} className={selectedId === action.id ? "selected" : ""} onClick={() => { selectedIdRef.current = action.id; setSelectedId(action.id); dirtyRef.current = false; setDirty(false); setForm(toForm(action)); }}>
              <strong>{action.name}</strong><small>{action.category} · v{action.version}{action.seedRevision === 0 ? " · 自定义" : ""}</small>
            </button>
          ))}
        </aside>

        <section className="rule-form" aria-label="行动规则表单">
          <div className="rule-form-heading"><h2>{form.version === null ? "新增行动" : `编辑：${form.name}`}</h2><span>ID {form.id || "保存时生成"}</span></div>
          <label>行动名称<input value={form.name} onChange={(event) => updateForm({ name: event.target.value })} /></label>
          <label>行动说明<textarea value={form.description} onChange={(event) => updateForm({ description: event.target.value })} /></label>
          <div className="rule-fields-row">
            <label>分类<select value={form.category} onChange={(event) => updateForm({ category: event.target.value as ActionRule["category"] })}>
              {["life", "perception", "movement", "cultivation", "production", "farming", "social", "intimate", "hostile", "combat", "legacy"].map((value) => <option key={value}>{value}</option>)}
            </select></label>
            <label>目标<select value={form.targetKind} onChange={(event) => updateForm({ targetKind: event.target.value as ActionRule["targetKind"] })}>
              {["self", "location", "player", "item", "plot"].map((value) => <option key={value}>{value}</option>)}
            </select></label>
            <label>行动耗时秒数<input type="number" min="0" value={form.durationSeconds} onChange={(event) => updateForm({ durationSeconds: event.target.value })} /></label>
            <label>冷却秒数<input type="number" min="0" value={form.cooldownSeconds} onChange={(event) => updateForm({ cooldownSeconds: event.target.value })} /></label>
            <label>技能持续秒数<input type="number" min="0" value={form.effectDurationSeconds} onChange={(event) => updateForm({ effectDurationSeconds: event.target.value })} /></label>
          </div>
          <div className="rule-fields-row">
            <label>可见性<select value={form.visibility} onChange={(event) => updateForm({ visibility: event.target.value as ActionRule["visibility"] })}>
              <option value="public">公开</option><option value="participants">仅参与者</option><option value="private">仅自己</option>
            </select></label>
            <label className="rule-checkbox"><input type="checkbox" checked={form.adult} onChange={(event) => updateForm({ adult: event.target.checked })} />成人规则</label>
          </div>
          {form.adult && <p className="rule-warning">成人规则必须为 player 目标、participants 可见，并在需求 JSON 中包含 `sameLocation: true` 与 `targetOnline: true`；它只能经逐次同意请求执行。</p>}
          <div className="rule-json-grid">
            <label>需求 JSON<textarea value={form.requirements} onChange={(event) => updateForm({ requirements: event.target.value })} /></label>
            <label>检定 JSON<textarea value={form.check} onChange={(event) => updateForm({ check: event.target.value })} /></label>
            <label>成本 JSON<textarea value={form.costs} onChange={(event) => updateForm({ costs: event.target.value })} /></label>
            <label>成功结果 JSON<textarea value={form.success} onChange={(event) => updateForm({ success: event.target.value })} /></label>
            <label>失败结果 JSON<textarea value={form.failure} onChange={(event) => updateForm({ failure: event.target.value })} /></label>
          </div>
          <label>结果文本<textarea value={form.resultTemplate} onChange={(event) => updateForm({ resultTemplate: event.target.value })} /></label>
          <div className="rule-form-actions"><button disabled={!connected} onClick={save}>保存规则{dirty ? " · 草稿" : ""}</button>{form.version !== null && <button disabled={!connected} onClick={() => send({ type: "rules.action.delete", actionId: form.id })}>停用规则</button>}</div>
        </section>

        <aside className="rule-binding" aria-label="地点行动绑定">
          <h2>地点与设施绑定</h2>
          <label>地图<select value={layerId} onChange={(event) => setLayerId(event.target.value)}>{rules.layers.map((layer) => <option key={layer.id} value={layer.id}>{layer.name}</option>)}</select></label>
          <label>搜索地点<input value={query} onChange={(event) => setQuery(event.target.value)} /></label>
          <button onClick={() => send({ type: "map.locations.search", layerId, query, limit: 100 })}>搜索</button>
          <label>搜索结果<select value={locationState?.location.id ?? ""} onChange={(event) => event.target.value && send({ type: "rules.location.inspect", locationId: event.target.value })}>
            <option value="">选择地点</option>{locationResults.map((location) => <option key={location.id} value={location.id}>{location.name} · ({location.gridX}, {location.gridY})</option>)}
          </select></label>
          {locationState && (
            <>
              <div className="rule-location-summary"><strong>{locationState.location.name}</strong><small>{locationState.location.region} · ({locationState.location.gridX}, {locationState.location.gridY})</small></div>
              <label>设施<select value={facilityId} onChange={(event) => setFacilityId(event.target.value)}><option value="">不指定设施</option>{locationState.facilities.map((facility) => <option key={facility.id} value={facility.id}>{facility.facilityType} · 品质{facility.quality}</option>)}</select></label>
              <label>优先级<input type="number" value={priority} onChange={(event) => setPriority(event.target.value)} /></label>
              <button disabled={!selectedId} onClick={() => send({ type: "rules.binding.upsert", locationId: locationState.location.id, actionId: selectedId, facilityId: facilityId || null, priority: Number.parseInt(priority, 10) || 0 })}>绑定当前规则</button>
              <div className="rule-bindings-list">{locationState.bindings.map((binding) => <article key={binding.id}><span><strong>{binding.actionName}</strong><small>{binding.facilityType ?? "无指定设施"} · 优先级 {binding.priority}</small></span><button onClick={() => send({ type: "rules.binding.delete", bindingId: binding.id })}>移除</button></article>)}</div>
            </>
          )}
        </aside>
      </div>
    </main>
  );
}
