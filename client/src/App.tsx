import { useEffect, useMemo, useRef, useState } from "react";
import { CenterScreen } from "./center";
import { MODELS, modelGroup } from "./models";
import { Picker } from "./pickers";
import { ConversationExtras } from "./talk";
import { collectEntries } from "../drop-read.mjs";
import { WorkspacePanel } from "./workspace-panel";

type Mode = "agent" | "plan" | "ask";
type Task = {
  id: string;
  title: string;
  workspace: string;
  mode: Mode;
  status: string;
  error: string;
  expertId: string;
  skillId: string;
  goal: string;
  updatedAt: number;
  liveThinking?: string;
  messages: Array<{ role: string; content: string; thinking?: string; toolName?: string; attachments?: string[]; toolCalls?: Array<{ name: string }> }>;
  artifacts: Array<{ path: string; action: string }>;
  changes: Array<{ path: string; action: string; before: string | null; after: string | null }>;
};

const MODES: Array<{ id: Mode; label: string; hint: string }> = [
  { id: "agent", label: "默认", hint: "直接执行，可以修改工作区文件" },
  { id: "plan", label: "计划", hint: "先给出方案，确认后再执行" },
  { id: "ask", label: "仅问答", hint: "只读工作区，不修改文件" },
];

const SCENES = [
  { id: "office", label: "日常办公", prompt: "写一份说明" },
  { id: "code", label: "代码开发", prompt: "读项目并总结" },
  { id: "design", label: "设计创意", prompt: "整理当前文件夹" },
];

async function api(path: string, init?: { method?: string; body?: unknown }) {
  const response = await fetch(path, {
    method: init?.method || "GET",
    headers: init?.body === undefined ? undefined : { "Content-Type": "application/json" },
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "请求失败");
  return data;
}

export function App() {
  const [state, setState] = useState<any>(null);
  const [workspaceInput, setWorkspaceInput] = useState("");
  const [picking, setPicking] = useState(false);
  const [activeId, setActiveId] = useState("");
  const [draft, setDraft] = useState("");
  const [mode, setMode] = useState<Mode>("agent");
  const [expertId, setExpertId] = useState("");
  const [skillId, setSkillId] = useState("");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [searchOpen, setSearchOpen] = useState(false);
  const [filterOpen, setFilterOpen] = useState(false);
  const [scene, setScene] = useState(SCENES[0].id);
  const [error, setError] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [attachments, setAttachments] = useState<Array<{ path: string; name?: string; count?: number; paths?: string[] }>>([]);
  const [openRequest, setOpenRequest] = useState({ path: "", nonce: 0 });
  const [treeVersion, setTreeVersion] = useState(0);
  const [centerOpen, setCenterOpen] = useState(false);
  const [talkQuery, setTalkQuery] = useState("");
  const [toolAnswer, setToolAnswer] = useState("");
  const [dragging, setDragging] = useState(false);
  const [adding, setAdding] = useState(false);
  const [mention, setMention] = useState<string | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [fileChoices, setFileChoices] = useState<string[]>([]);
  const uploadInput = useRef<HTMLInputElement>(null);
  const uploadRef = useRef<(source: FileList | File[] | { entries: DropEntry[]; files: File[] }) => Promise<void>>(async () => {});
  const draftRef = useRef<HTMLTextAreaElement>(null);
  const history = useRef<string[]>([]);
  const historyAt = useRef(0);

  async function refresh() {
    const next = await api("/api/state");
    setState(next);
    return next;
  }

  useEffect(() => {
    refresh().catch((reason) => setError(reason.message || "无法连接本地服务"));
  }, []);

  useEffect(() => {
    let hideTimer = 0;
    const hasFiles = (event: DragEvent) => [...(event.dataTransfer?.types || [])].includes("Files");
    const over = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
      window.clearTimeout(hideTimer);
      setDragging((current) => current || true);
    };
    const stop = () => {
      window.clearTimeout(hideTimer);
      hideTimer = window.setTimeout(() => setDragging(false), 300);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        window.clearTimeout(hideTimer);
        setDragging(false);
      }
    };
    let lastDrop = 0;
    const drop = (event: DragEvent) => {
      const items = [...(event.dataTransfer?.items || [])];
      const entries = items.map((item) => typeof item.webkitGetAsEntry === "function" ? item.webkitGetAsEntry() : null).filter(Boolean);
      const files = [...(event.dataTransfer?.files || [])];
      if ((!entries.length && !files.length) || event.timeStamp === lastDrop) return;
      lastDrop = event.timeStamp;
      event.preventDefault();
      window.clearTimeout(hideTimer);
      setDragging(false);
      uploadRef.current({ entries, files }).catch((reason) => setError(reason instanceof Error ? reason.message : "上传失败"));
    };
    window.addEventListener("dragenter", over);
    window.addEventListener("dragover", over);
    window.addEventListener("drop", drop, true);
    window.addEventListener("dragend", stop);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("dragenter", over);
      window.removeEventListener("dragover", over);
      window.removeEventListener("drop", drop, true);
      window.removeEventListener("dragend", stop);
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  const running = Boolean(state?.tasks?.some((task: Task) => task.status === "running"));
  useEffect(() => {
    if (!running) return undefined;
    const timer = setInterval(() => {
      refresh().catch(() => {});
    }, 400);
    return () => clearInterval(timer);
  }, [running]);

  const workspace = state?.currentWorkspace || "";
  const mentionHits = mention === null
    ? []
    : fileChoices.filter((item) => item.toLowerCase().includes(mention.toLowerCase())).slice(0, 8);
  const mentionOpen = mention !== null;
  useEffect(() => {
    if (!mentionOpen || !workspace) return undefined;
    let cancel = false;
    api(`/api/tree?workspace=${encodeURIComponent(workspace)}`)
      .then((data) => { if (!cancel) setFileChoices(flattenFiles(data.tree || [])); })
      .catch(() => { if (!cancel) setFileChoices([]); });
    return () => { cancel = true; };
  }, [mentionOpen, workspace, treeVersion]);

  const active: Task | null = state?.tasks?.find((task: Task) => task.id === activeId) || null;

  const visibleTasks = useMemo(() => {
    const tasks = [...(state?.tasks || [])] as Task[];
    return tasks
      .filter((task) => matchFilter(task, filter) && matchQuery(task, query))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }, [state, filter, query]);

  async function openWorkspace(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    try {
      const next = await api("/api/workspace", { method: "POST", body: { path: workspaceInput } });
      setState(next);
      setPicking(false);
      setActiveId("");
    } catch (reason: any) {
      setError(reason.message);
    }
  }

  async function send(event: React.FormEvent) {
    event.preventDefault();
    const text = draft.trim();
    const files = attachments.flatMap((item) => item.path.startsWith("pending:") ? [] : (item.paths?.length ? item.paths : [item.path]));
    if (!text && files.length === 0) {
      setError("请先写任务内容");
      return;
    }
    setSubmitting(true);
    setError("");
    try {
      const payload = { text, mode, expertId, skillId, workspace, attachments: files };
      const task = active
        ? await api(`/api/tasks/${active.id}/messages`, { method: "POST", body: payload })
        : await api("/api/tasks", { method: "POST", body: payload });
      if (text) history.current = [text, ...history.current.filter((item) => item !== text)].slice(0, 20);
      historyAt.current = 0;
      setDraft("");
      setMention(null);
      setAttachments([]);
      setActiveId(task.id);
      setTreeVersion((value) => value + 1);
      await refresh();
    } catch (reason: any) {
      setError(reason.message);
    } finally {
      setSubmitting(false);
    }
  }

  async function confirm() {
    if (!active) return;
    setError("");
    try {
      await api(`/api/tasks/${active.id}/confirm`, { method: "POST" });
      await refresh();
    } catch (reason: any) {
      setError(reason.message);
    }
  }

  async function markDone() {
    if (!active) return;
    await api(`/api/tasks/${active.id}`, { method: "POST", body: { status: "done" } });
    await refresh();
  }

  async function removeTask() {
    if (!active) return;
    await api(`/api/tasks/${active.id}`, { method: "DELETE" });
    setActiveId("");
    await refresh();
  }

  async function settleTool(decision, answer = "") {
    if (!active) return;
    setError("");
    try {
      await api(`/api/tasks/${active.id}/tool`, { method: "POST", body: { decision, answer } });
      setToolAnswer("");
      await refresh();
    } catch (reason: any) {
      setError(reason.message);
    }
  }

  async function shareTask() {
    if (!active) return;
    setError("");
    try {
      const saved = await api("/api/share", { method: "POST", body: { taskId: active.id } });
      setOpenRequest({ path: saved.path, nonce: Date.now() });
      setTreeVersion((value) => value + 1);
    } catch (reason: any) {
      setError(reason.message);
    }
  }

  async function uploadFiles(source: FileList | File[] | { entries: DropEntry[]; files: File[] }) {
    if (!workspace) {
      setError("请先打开工作区");
      return;
    }
    const dropped = source instanceof FileList || Array.isArray(source)
      ? { entries: [] as DropEntry[], files: [...source] }
      : source;
    const preview = [
      ...(dropped.entries || []).map((entry) => ({ name: entry.name || "文件夹", folder: Boolean(entry.isDirectory) })),
      ...(dropped.files || []).map((file) => ({ name: file.name || "附件", folder: false })),
    ];
    if (!preview.length) return;
    if (attachments.length + preview.length > 50) {
      setError("一次最多添加 50 项");
      return;
    }
    const pendingKey = `pending:${Date.now()}`;
    const pending = preview.map((item, index) => ({ path: `${pendingKey}:${index}`, name: item.name, count: item.folder ? 1 : 0 }));
    setAttachments((current) => [...current, ...pending].slice(0, 50));
    setAdding(true);
    setError("");
    try {
      const fromFolders = await collectEntries(dropped.entries || []);
      const extras = (dropped.files || []).flatMap((file) => {
        const relativePath = file.webkitRelativePath || "";
        if (!relativePath || fromFolders.some((item) => item.relativePath === relativePath)) return [];
        return [{ file, relativePath }];
      });
      const collected = fromFolders.length
        ? [...fromFolders, ...extras]
        : (dropped.files || []).map((file) => ({ file, relativePath: file.webkitRelativePath || file.name }));
      if (!collected.length) throw new Error("这个文件夹里没有文件");
      if (collected.length >= 200) setError("文件较多，先加入了前 200 个");
      const grouped = groupDropped(collected);
      const saved = [];
      for (const card of grouped) {
        const paths = [];
        for (const item of card.items) {
          const response = await fetch(`/api/upload?workspace=${encodeURIComponent(workspace)}&name=${encodeURIComponent(item.file.name || card.name)}&path=${encodeURIComponent(item.relativePath)}`, {
            method: "POST",
            body: item.file,
          });
          const data = await response.json().catch(() => ({}));
          if (!response.ok) throw new Error(data.error || "上传失败");
          paths.push(data.path);
        }
        saved.push({ path: card.count ? paths[0].split("/").slice(0, -1).join("/") || paths[0] : paths[0], name: card.name, count: card.count, paths });
      }
      setAttachments((current) => [...current.filter((item) => !pending.some((chip) => chip.path === item.path)), ...saved].slice(0, 50));
      setTreeVersion((value) => value + 1);
    } catch (reason) {
      setAttachments((current) => current.filter((item) => !pending.some((chip) => chip.path === item.path)));
      throw reason;
    } finally {
      setAdding(false);
    }
  }
  uploadRef.current = uploadFiles;

  function noteMention(value: string, caret: number) {
    const match = /(?:^|\s)@([^\s@]*)$/.exec(value.slice(0, caret));
    setMention(match ? match[1] : null);
    setMentionIndex(0);
  }

  function insertMention(filePath: string) {
    const caret = draftRef.current?.selectionStart ?? draft.length;
    const before = draft.slice(0, caret).replace(/@([^\s@]*)$/, `@${filePath} `);
    setDraft(before + draft.slice(caret));
    setMention(null);
    draftRef.current?.focus();
  }

  if (!state) return <main className="booting">正在打开 OpenWorkBuddy…</main>;

  return (
    <div className="app">
      {error && <div className="banner" role="alert">{error}</div>}
      {!workspace || picking ? (
        <div className="gate">
          <div className="brand">
            <span className="mark">OW</span>
            <h1>OpenWorkBuddy</h1>
          </div>
          <Welcome
            value={workspaceInput}
            recent={state.recentWorkspaces || []}
            onChange={setWorkspaceInput}
            onSubmit={openWorkspace}
            onPick={(item) => setWorkspaceInput(item)}
          />
        </div>
      ) : (
        <div className={active ? "shell has-result" : "shell"}>
          {dragging && (
            <label className="drop-layer">
              松开即可添加文件
              <input
                aria-label="拖入文件"
                type="file"
                multiple
                onChange={(event) => {
                  const files = [...(event.target.files || [])];
                  event.target.value = "";
                  setDragging(false);
                  if (files.length) uploadFiles(files).catch((reason) => setError(reason.message));
                }}
              />
            </label>
          )}
          <aside className="sidebar">
            <div className="side-brand">
              <h1>OpenWorkBuddy</h1>
              <span>本地</span>
            </div>
            <div className="side-tools">
              <button type="button" aria-pressed={searchOpen} onClick={() => setSearchOpen((open) => !open)}>搜索</button>
              <button type="button" aria-pressed={filterOpen} onClick={() => setFilterOpen((open) => !open)}>筛选</button>
            </div>
            {searchOpen && <input aria-label="搜索任务" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索任务" />}
            {filterOpen && (
              <div className="filters">
                {[
                  ["all", "全部"],
                  ["open", "未完成"],
                  ["confirm", "待确认"],
                  ["done", "已完成"],
                ].map(([id, label]) => (
                  <button type="button" key={id} aria-pressed={filter === id} onClick={() => setFilter(id)}>{label}</button>
                ))}
              </div>
            )}
            <nav className="side-nav">
              <button type="button" className={active ? "" : "on"} onClick={() => setActiveId("")}>新建任务</button>
              <button type="button" onClick={() => setCenterOpen(true)}>专家</button>
              <button type="button" onClick={() => setCenterOpen(true)}>技能</button>
              <button type="button" onClick={() => setCenterOpen(true)}>资料库</button>
            </nav>
            <div className="groups">
              <section>
                <h2>任务 ({visibleTasks.length})</h2>
                {visibleTasks.length === 0 && <p className="empty">任务会列在这里</p>}
                {visibleTasks.map((task) => (
                  <button type="button" key={task.id} className={task.id === activeId ? "task active" : "task"} onClick={() => setActiveId(task.id)}>
                    <strong>{task.title}</strong>
                    <span>{relativeTime(task.updatedAt)}</span>
                  </button>
                ))}
              </section>
              <section>
                <h2>空间</h2>
                <button type="button" className="space-name" title={workspace} onClick={() => { setPicking(true); setWorkspaceInput(workspace); }}>{folderName(workspace)}</button>
                {visibleTasks.filter((task) => task.workspace === workspace).map((task) => (
                  <button type="button" key={`space-${task.id}`} className={task.id === activeId ? "task nested active" : "task nested"} onClick={() => setActiveId(task.id)}>
                    <strong>{task.title}</strong>
                    <span>{relativeTime(task.updatedAt)}</span>
                  </button>
                ))}
              </section>
            </div>
            <div className="side-foot">
              <span className="avatar">{folderName(workspace).charAt(0) || "O"}</span>
              <button type="button" onClick={() => setSettingsOpen(true)}>设置</button>
            </div>
          </aside>
          <main className={active ? "conversation has-task" : "conversation new-task"}>
            {active ? (
              <>
                <div className="conversation-head">
                  <div>
                    <h2>{active.title}</h2>
                    <p>{statusText(active.status)} · {modeText(active.mode)}</p>
                  </div>
                  <div className="row head-actions">
                    <details className="history">
                      <summary>历史提问</summary>
                      <ConversationExtras
                        messages={active.messages}
                        query={talkQuery}
                        onQuery={setTalkQuery}
                        onJump={(index) => document.getElementById(`msg-${index}`)?.scrollIntoView({ block: "center" })}
                      />
                    </details>
                    <details className="overview-pop">
                      <summary>任务概览</summary>
                      <div>
                        {(active.artifacts || []).length === 0 && <p>暂无产物文件</p>}
                        {(active.artifacts || []).map((artifact) => (
                          <button type="button" key={artifact.path} onClick={() => setOpenRequest({ path: artifact.path, nonce: Date.now() })}>{artifact.path}</button>
                        ))}
                      </div>
                    </details>
                    <button type="button" onClick={shareTask} disabled={!active}>分享</button>
                    <button type="button" onClick={markDone} disabled={active.status === "running"}>标为完成</button>
                    <button type="button" onClick={removeTask} disabled={active.status === "running"}>删除</button>
                  </div>
                </div>
                <div className="messages" aria-live="polite">
                  {active.messages.map((message, index) => (message.content || message.thinking || message.role === "tool") && (
                    <article id={`msg-${index}`} key={`${message.role}-${index}`} className={`message ${message.role}`}>
                      {message.role === "tool" ? (
                        <details>
                          <summary>{speaker(message)} · {firstLine(message.content)}</summary>
                          {message.content && <MessageBody content={message.content} onOpen={(filePath) => setOpenRequest({ path: filePath, nonce: Date.now() })} />}
                        </details>
                      ) : (
                        <>
                          <span>{speaker(message)}</span>
                          {message.thinking && <Thinking text={message.thinking} />}
                          {shownText(message) && <MessageBody content={shownText(message)} onOpen={(filePath) => setOpenRequest({ path: filePath, nonce: Date.now() })} />}
                          {message.role === "user" && attachmentPaths(message).length > 0 && <p className="attach-note">{attachmentLabel(attachmentPaths(message))}</p>}
                        </>
                      )}
                    </article>
                  ))}
                  {active.status === "running" && active.liveThinking && <Thinking text={active.liveThinking} live />}
                  {active.status === "running" && <p className="pending">{active.liveThinking ? "思考中…" : "正在执行…"}</p>}
                </div>
              </>
            ) : (
              <div className="hero">
                <h2>OpenWorkBuddy</h2>
                <p className="hero-sub">本地工作台</p>
                <div className="scenes">
                  {SCENES.map((item) => (
                    <button type="button" key={item.id} aria-pressed={scene === item.id} onClick={() => { setScene(item.id); setDraft(item.prompt); }}>{item.label}</button>
                  ))}
                </div>
              </div>
            )}
            {active?.status === "awaiting_confirm" && <button type="button" className="primary confirm" onClick={confirm}>确认执行</button>}
            {active?.status === "awaiting_tool" && (
              <div className="ask-card">
                <p className="ask-kicker">{active.pendingTool?.kind === "question" ? "需要你回答" : "需要你允许"}</p>
                <p className="ask-body">{active.pendingTool?.reason || "需要你确认这个操作。"}</p>
                {active.pendingTool?.kind === "question" ? (
                  <form className="inline-form" onSubmit={(event) => { event.preventDefault(); settleTool("allow", toolAnswer); }}>
                    <input aria-label="回答问题" value={toolAnswer} onChange={(event) => setToolAnswer(event.target.value)} />
                    <button type="submit" className="primary">提交回答</button>
                  </form>
                ) : (
                  <div className="row">
                    <button type="button" className="primary" onClick={() => settleTool("allow")}>允许</button>
                    <button type="button" onClick={() => settleTool("deny")}>拒绝</button>
                  </div>
                )}
              </div>
            )}
            <form className="composer" onSubmit={send}>
              {adding && <p className="adding">正在添加文件…</p>}
              {attachments.length > 0 && (
                <div className="attach-row">
                  {attachments.map((file) => {
                    const mark = file.count ? { ext: "DIR", kind: "doc", name: file.name || "文件夹" } : fileMark(file.name || file.path);
                    return (
                      <div className="attach-card" key={file.path}>
                        <i className={`type-mark ${mark.kind}`}>{mark.ext}</i>
                        <span title={file.paths?.join("\n") || file.path}>{mark.name}{file.count ? ` · ${file.count} 个文件` : ""}</span>
                        <button type="button" onClick={() => setAttachments((current) => current.filter((item) => item.path !== file.path))}>移除</button>
                      </div>
                    );
                  })}
                </div>
              )}
              {mentionHits.length > 0 && (
                <div className="mention-menu">
                  {mentionHits.map((item, index) => (
                    <button type="button" key={item} className={index === mentionIndex ? "on" : ""} onMouseDown={(event) => { event.preventDefault(); insertMention(item); }}>{item}</button>
                  ))}
                </div>
              )}
              <textarea
                ref={draftRef}
                aria-label="任务内容"
                value={draft}
                placeholder="今天帮你做些什么？ @ 引用文件"
                onChange={(event) => {
                  historyAt.current = 0;
                  setDraft(event.target.value);
                  noteMention(event.target.value, event.target.selectionStart);
                }}
                onPaste={(event) => {
                  if (!event.clipboardData.files.length) return;
                  event.preventDefault();
                  uploadFiles(event.clipboardData.files).catch((reason) => setError(reason.message));
                }}
                onKeyDown={(event) => {
                  if (mentionHits.length && event.key === "ArrowDown") {
                    event.preventDefault();
                    setMentionIndex((index) => Math.min(mentionHits.length - 1, index + 1));
                    return;
                  }
                  if (mentionHits.length && event.key === "ArrowUp") {
                    event.preventDefault();
                    setMentionIndex((index) => Math.max(0, index - 1));
                    return;
                  }
                  if (mentionHits.length && (event.key === "Enter" || event.key === "Tab")) {
                    event.preventDefault();
                    insertMention(mentionHits[Math.min(mentionIndex, mentionHits.length - 1)]);
                    return;
                  }
                  if (mentionHits.length && event.key === "Escape") {
                    event.preventDefault();
                    setMention(null);
                    return;
                  }
                  const recalled = historyAt.current > 0 && draft === history.current[historyAt.current - 1];
                  if (event.key === "ArrowUp" && (draft.trim() === "" || recalled)) {
                    event.preventDefault();
                    const index = Math.min(history.current.length, (draft.trim() === "" ? 0 : historyAt.current) + 1);
                    if (index < 1) return;
                    historyAt.current = index;
                    setDraft(history.current[index - 1]);
                    return;
                  }
                  if (event.key === "ArrowDown" && historyAt.current > 0) {
                    event.preventDefault();
                    historyAt.current -= 1;
                    setDraft(historyAt.current === 0 ? "" : history.current[historyAt.current - 1]);
                    return;
                  }
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    send(event);
                  }
                }}
              />
              <div className="composer-bar">
                <div className="composer-tools">
                  <div className="modes">
                    {MODES.map((item) => (
                      <button type="button" key={item.id} data-mode={item.id} aria-pressed={mode === item.id} title={item.hint} onClick={() => setMode(item.id)}>{item.label}</button>
                    ))}
                  </div>
                  <Picker
                    ariaLabel="模型"
                    text={state.settings?.model || MODELS[0]}
                    value={state.settings?.model || MODELS[0]}
                    searchable
                    searchLabel="搜索模型"
                    options={MODELS.map((item) => ({ id: item, label: item, group: modelGroup(item) }))}
                    onChange={(next) => {
                      api("/api/settings", { method: "POST", body: { provider: "openai", model: next } })
                        .then(() => refresh())
                        .catch((reason) => setError(reason.message));
                    }}
                  />
                  <Picker
                    ariaLabel="专家"
                    text={expertLabel(state.experts, expertId)}
                    value={expertId}
                    searchable
                    searchLabel="搜索专家"
                    options={[
                      { id: "", label: "不指定专家" },
                      ...(state.experts || []).map((expert: any) => ({
                        id: expert.id,
                        label: expert.kind === "team" ? `专家团 · ${expert.name}` : expert.name,
                        group: expert.kind === "team" ? "专家团" : "专家",
                      })),
                    ]}
                    onChange={setExpertId}
                  />
                  <Picker
                    ariaLabel="技能"
                    text={skillLabel(state.skills, skillId)}
                    value={skillId}
                    searchable
                    searchLabel="搜索技能"
                    options={[
                      { id: "", label: "不指定技能" },
                      ...(state.skills || []).map((skill: any) => ({ id: skill.id, label: skill.name })),
                    ]}
                    onChange={setSkillId}
                  />
                </div>
                <div className="row">
                  <input ref={uploadInput} aria-label="上传文件" type="file" multiple hidden onChange={(event) => {
                    if (event.target.files?.length) uploadFiles(event.target.files).catch((reason) => setError(reason.message));
                    event.target.value = "";
                  }} />
                  <button type="button" className="ghost" onClick={() => uploadInput.current?.click()}>上传</button>
                  <button type="submit" className="primary send" disabled={submitting || active?.status === "running" || active?.status === "awaiting_tool"}>{active ? "发送" : "开始执行"}</button>
                </div>
              </div>
            </form>
            {!active && (
              <button type="button" className="space-link" onClick={() => { setPicking(true); setWorkspaceInput(workspace); }}>选择工作空间 · {folderName(workspace)}</button>
            )}
          </main>
          {active && <WorkspacePanel workspace={workspace} active={active} openRequest={openRequest} treeVersion={treeVersion} onQuote={(text) => setDraft((current) => current ? `${current}\n\n${text}` : text)} />}
        </div>
      )}
      {centerOpen && (
        <div className="center-layer">
          <CenterScreen
            experts={state.experts || []}
            skills={state.skills || []}
            library={state.library || []}
            notices={state.notices || []}
            onClose={() => setCenterOpen(false)}
            onSummon={(expertId) => { setExpertId(expertId); setCenterOpen(false); }}
            onUseSkill={(skillId) => { setSkillId(skillId); setCenterOpen(false); }}
            onAttach={(filePath) => setAttachments((current) => current.some((item) => item.path === filePath) ? current : [...current, { path: filePath }])}
            onOpenNotice={(taskId) => { setActiveId(taskId); setCenterOpen(false); }}
            onCreateExpert={async (input) => { await api("/api/experts", { method: "POST", body: { ...input, workspace } }); await refresh(); }}
            onCreateSkill={async (input) => { await api("/api/skills", { method: "POST", body: { ...input, workspace } }); await refresh(); }}
            onCreateNote={async (input) => { await api("/api/library", { method: "POST", body: { ...input, workspace } }); await refresh(); }}
          />
        </div>
      )}
      {settingsOpen && (
        <Settings
          settings={state.settings}
          onClose={() => setSettingsOpen(false)}
          onSaved={async () => {
            await refresh();
            setSettingsOpen(false);
          }}
        />
      )}
    </div>
  );
}

function Welcome({ value, recent, onChange, onSubmit, onPick }: {
  value: string;
  recent: string[];
  onChange: (value: string) => void;
  onSubmit: (event: React.FormEvent) => void;
  onPick: (value: string) => void;
}) {
  return (
    <form className="welcome" onSubmit={onSubmit}>
      <h2>打开一个工作文件夹</h2>
      <p>任务产生的文件会直接写在这个文件夹里。关闭程序后，仍然可以用其他软件打开。</p>
      <input aria-label="工作区路径" value={value} onChange={(event) => onChange(event.target.value)} placeholder="例如 D:\notes" />
      <button type="submit" className="primary">打开工作区</button>
      {recent.length > 0 && (
        <div className="recent">
          <span>最近使用</span>
          {recent.map((item) => <button type="button" key={item} onClick={() => onPick(item)}>{item}</button>)}
        </div>
      )}
    </form>
  );
}

function Settings({ settings, onClose, onSaved }: { settings: any; onClose: () => void; onSaved: () => Promise<void> }) {
  const [provider, setProvider] = useState(settings.provider || "local");
  const [baseUrl, setBaseUrl] = useState(settings.baseUrl || "");
  const [model, setModel] = useState(settings.model || "");
  const [apiKey, setApiKey] = useState("");
  const [error, setError] = useState("");

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    try {
      const body: Record<string, string> = { provider, baseUrl, model };
      if (apiKey.trim()) body.apiKey = apiKey.trim();
      await api("/api/settings", { method: "POST", body });
      await onSaved();
    } catch (reason: any) {
      setError(reason.message);
    }
  }

  return (
    <div className="dialog-backdrop">
      <form className="dialog" onSubmit={save}>
        <h2>模型设置</h2>
        <p>默认使用本机规则完成文件任务。填写兼容 OpenAI 接口的地址和密钥后，可以改用外部模型。</p>
        <label>提供方
          <select aria-label="模型提供方" value={provider} onChange={(event) => setProvider(event.target.value)}>
            <option value="local">本地</option>
            <option value="openai">OpenAI 兼容接口</option>
          </select>
        </label>
        <label>接口地址
          <input aria-label="接口地址" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} />
        </label>
        <label>模型
          <select aria-label="模型名称" value={MODELS.includes(model) ? model : MODELS[0]} onChange={(event) => setModel(event.target.value)}>
            {MODELS.map((item) => <option key={item} value={item}>{item}</option>)}
          </select>
        </label>
        <label>密钥
          <input aria-label="接口密钥" type="password" value={apiKey} placeholder={settings.hasApiKey ? "已保存，留空则不修改" : "没有保存密钥"} onChange={(event) => setApiKey(event.target.value)} />
        </label>
        {error && <p className="fail">{error}</p>}
        <div className="row">
          <button type="button" onClick={onClose}>取消</button>
          <button type="submit" className="primary">保存</button>
        </div>
      </form>
    </div>
  );
}

function matchFilter(task: Task, filter: string) {
  if (filter === "open") return task.status !== "done";
  if (filter === "confirm") return task.status === "awaiting_confirm" || task.status === "awaiting_tool";
  if (filter === "done") return task.status === "done";
  return true;
}

function matchQuery(task: Task, query: string) {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return [task.title, task.goal, ...task.messages.map((message) => message.content || "")]
    .join("\n")
    .toLowerCase()
    .includes(needle);
}

type DropEntry = { name?: string; isDirectory?: boolean; isFile?: boolean; webkitGetAsEntry?: () => DropEntry | null };

function groupDropped(collected: Array<{ file: File; relativePath: string }>) {
  const folders = new Map<string, Array<{ file: File; relativePath: string }>>();
  const files: Array<{ file: File; relativePath: string }> = [];
  for (const item of collected) {
    const parts = item.relativePath.split("/");
    if (parts.length > 1) {
      const name = parts[0];
      folders.set(name, [...(folders.get(name) || []), item]);
    } else files.push(item);
  }
  return [
    ...[...folders.entries()].map(([name, items]) => ({ name, count: items.length, items })),
    ...files.map((item) => ({ name: item.file.name || item.relativePath, count: 0, items: [item] })),
  ];
}

function flattenFiles(nodes: Array<{ type: string; path: string; children?: any[] }>, out: string[] = []) {
  for (const node of nodes) {
    if (node.type === "file") out.push(node.path);
    else if (node.children) flattenFiles(node.children, out);
  }
  return out;
}

function fileMark(filePath: string) {
  const name = String(filePath || "").split(/[/\\]/).filter(Boolean).pop() || filePath;
  const raw = name.includes(".") ? name.split(".").pop()!.slice(0, 4).toUpperCase() : "FILE";
  const kind = raw === "PY" ? "py" : raw === "HTML" || raw === "HTM" ? "web" : raw === "PNG" || raw === "JPG" || raw === "GIF" ? "img" : raw === "JSON" || raw === "CSV" ? "data" : "doc";
  return { name, ext: raw.slice(0, 3), kind };
}

function relativeTime(at: number) {
  const minutes = Math.max(0, Math.round((Date.now() - at) / 60000));
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes}分钟前`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}小时前`;
  return `${Math.round(hours / 24)}天前`;
}

function statusText(status: string) {
  if (status === "running") return "执行中";
  if (status === "awaiting_confirm" || status === "awaiting_tool") return "待确认";
  if (status === "done") return "已完成";
  if (status === "error") return "失败";
  return "进行中";
}

function modeText(mode: string) {
  return MODES.find((item) => item.id === mode)?.label || "默认";
}

function Thinking({ text, live = false }: { text: string; live?: boolean }) {
  const body = useRef<HTMLPreElement>(null);
  useEffect(() => {
    if (live && body.current) body.current.scrollTop = body.current.scrollHeight;
  }, [live, text]);
  return (
    <details className={live ? "thinking live" : "thinking"} open={live ? true : undefined}>
      {live ? <summary>正在思考</summary> : <summary>思考过程</summary>}
      <pre ref={body}>{text}</pre>
    </details>
  );
}

function speaker(message: { role: string; toolName?: string }) {
  if (message.role === "user") return "你";
  if (message.role === "tool") return toolLabel(message.toolName || "");
  return "OpenWorkBuddy";
}

function toolLabel(name: string) {
  const labels: Record<string, string> = {
    Read: "读取文件",
    Grep: "搜索",
    Glob: "查找文件",
    Write: "写入文件",
    Edit: "编辑文件",
    MultiEdit: "编辑文件",
    Bash: "执行命令",
    PowerShell: "执行命令",
    Skill: "技能",
    Agent: "子代理",
    AskUserQuestion: "向你提问",
    WebFetch: "获取网页",
    list_dir: "列出文件",
    read_file: "读取文件",
    search_text: "搜索",
    write_file: "写入文件",
    run_command: "执行命令",
  };
  return labels[name] || "操作";
}

function shownText(message: { role: string; content: string }) {
  if (message.role !== "user") return message.content || "";
  return String(message.content || "").replace(/\n+附件：[\s\S]*$/, "").trim();
}

function attachmentPaths(message: { content?: string; attachments?: string[] }) {
  if (Array.isArray(message.attachments) && message.attachments.length) return message.attachments.filter(Boolean);
  const match = String(message.content || "").match(/\n附件：\n([\s\S]*)$/);
  if (!match) return [];
  return match[1].split(/\n/).map((line) => line.replace(/^- /, "").trim()).filter(Boolean);
}

function attachmentLabel(paths: string[]) {
  if (paths.length === 1) return paths[0].split("/").filter(Boolean).pop() || "1 个文件";
  const parents = paths.map((item) => item.split("/").slice(0, -1));
  let common = parents[0] || [];
  for (const parent of parents.slice(1)) {
    const next = [];
    for (let index = 0; index < Math.min(common.length, parent.length); index += 1) {
      if (common[index] !== parent[index]) break;
      next.push(common[index]);
    }
    common = next;
  }
  const name = common.filter(Boolean).pop();
  return name ? `${name} · ${paths.length} 个文件` : `${paths.length} 个文件`;
}

function firstLine(text: string) {
  return String(text || "").split(/\r?\n/).find((line) => line.trim()) || "查看步骤";
}

function MessageBody({ content, onOpen }: { content: string; onOpen: (path: string) => void }) {
  const parts = content.split(/((?:[\w.\-\u4e00-\u9fff]+\/)*[\w.\-\u4e00-\u9fff]+\.[A-Za-z0-9]{1,8})/g);
  return (
    <div className="bubble">
      {parts.map((part, index) => index % 2 === 1
        ? <button type="button" className="path-link" key={`${part}-${index}`} onClick={() => onOpen(part)}>{part}</button>
        : <span key={index}>{part}</span>)}
    </div>
  );
}

function expertLabel(list: Array<{ id: string; name: string; kind?: string }> | undefined, id: string) {
  if (!id) return "不指定专家";
  const item = list?.find((expert) => expert.id === id);
  if (!item) return "不指定专家";
  return item.kind === "team" ? `专家团 · ${item.name}` : item.name;
}

function skillLabel(list: Array<{ id: string; name: string }> | undefined, id: string) {
  if (!id) return "不指定技能";
  return list?.find((skill) => skill.id === id)?.name || "不指定技能";
}

function folderName(input: string) {
  const parts = String(input || "").split(/[\\/]/).filter(Boolean);
  return parts.at(-1) || "工作区";
}

function shorten(input: string) {
  if (input.length <= 48) return input;
  return `…${input.slice(-46)}`;
}
