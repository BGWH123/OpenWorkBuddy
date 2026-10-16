import { useEffect, useMemo, useState } from "react";
import { RichBody, quoteSnippet } from "./talk";
import { NewTabPicker, TabStrip, useDeskTabs } from "./tabs";

type TreeNode = { name: string; path: string; type: "file" | "dir"; children?: TreeNode[] };
type OpenFile = { path: string; kind: string; content: string; saved: string; mtimeMs: number; notice: string };
type Change = { path: string; action: string; before: string | null; after: string | null };

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

export function WorkspacePanel({ workspace, active, openRequest, treeVersion, onQuote }: {
  workspace: string;
  active: any;
  openRequest: { path: string; nonce: number };
  treeVersion: number;
  onQuote?: (text: string) => void;
}) {
  const desk = useDeskTabs([
    { id: "artifacts", kind: "artifacts", title: "产物" },
    { id: "files", kind: "files", title: "文件" },
    { id: "changes", kind: "changes", title: "变更" },
    { id: "browser", kind: "browser", title: "浏览器" },
    { id: "terminal", kind: "terminal", title: "终端" },
  ]);
  const activeDesk = desk.tabs.find((item) => item.id === desk.activeId);
  const tab = activeDesk?.payload === "picker" ? "picker" : (activeDesk?.kind || "files");
  const [tree, setTree] = useState<TreeNode[]>([]);
  const [query, setQuery] = useState("");
  const [files, setFiles] = useState<OpenFile[]>([]);
  const [current, setCurrent] = useState("");
  const [preview, setPreview] = useState<any>(null);
  const [selectedChange, setSelectedChange] = useState(0);
  const [address, setAddress] = useState("");
  const [browserUrl, setBrowserUrl] = useState("");
  const [command, setCommand] = useState("");
  const [terminal, setTerminal] = useState<Array<{ command: string; output: string; code: number }>>([]);
  const [creating, setCreating] = useState("");
  const [draftPath, setDraftPath] = useState("");
  const [error, setError] = useState("");

  const openFile = files.find((file) => file.path === current) || null;
  const changes: Change[] = active?.changes || [];
  const artifacts = active?.artifacts || [];

  async function reloadTree() {
    const data = await api(`/api/tree?workspace=${encodeURIComponent(workspace)}`);
    setTree(data.tree || []);
  }

  useEffect(() => {
    reloadTree().catch((reason) => setError(reason.message));
  }, [workspace, treeVersion, active?.updatedAt, active?.status]);

  useEffect(() => {
    desk.activate(active?.artifacts?.length ? "artifacts" : "files");
    setPreview(null);
    setSelectedChange(0);
  }, [active?.id]);

  useEffect(() => {
    if (!openRequest.path) return;
    openPath(openRequest.path).catch((reason) => setError(reason.message));
  }, [openRequest.nonce]);

  async function openPath(relative: string, force = false) {
    const existing = files.find((file) => file.path === relative);
    if (existing && !force && existing.content !== existing.saved) {
      setCurrent(relative);
      desk.activate("files");
      return;
    }
    const data = await api(`/api/file?workspace=${encodeURIComponent(workspace)}&path=${encodeURIComponent(relative)}`);
    const next: OpenFile = {
      path: data.path,
      kind: data.kind,
      content: data.content || "",
      saved: data.content || "",
      mtimeMs: data.mtimeMs,
      notice: "",
    };
    setFiles((list) => [next, ...list.filter((file) => file.path !== next.path)].slice(0, 8));
    setCurrent(next.path);
    desk.activate("files");
    setError("");
  }

  async function showArtifact(relative: string) {
    desk.activate("artifacts");
    setError("");
    const data = await api(`/api/file?workspace=${encodeURIComponent(workspace)}&path=${encodeURIComponent(relative)}`);
    setPreview(data);
  }

  function updateCurrent(content: string) {
    setFiles((list) => list.map((file) => file.path === current ? { ...file, content, notice: "" } : file));
  }

  async function save(pathName = current, content = openFile?.content ?? "", mtimeMs = openFile?.mtimeMs) {
    try {
      const saved = await api("/api/file", { method: "POST", body: { workspace, path: pathName, content, mtimeMs } });
      setFiles((list) => list.map((file) => file.path === current ? { ...file, path: saved.path, content, saved: content, mtimeMs: saved.mtimeMs, notice: "已保存" } : file));
      setCurrent(saved.path);
      setError("");
      await reloadTree();
    } catch (reason: any) {
      setFiles((list) => list.map((file) => file.path === current ? { ...file, notice: reason.message } : file));
    }
  }

  async function createEntry(event: React.FormEvent) {
    event.preventDefault();
    const target = draftPath.trim();
    if (!target) return;
    if (creating === "dir") await api("/api/mkdir", { method: "POST", body: { workspace, path: target } });
    else {
      await api("/api/file", { method: "POST", body: { workspace, path: target, content: "" } });
      await openPath(target, true);
    }
    setCreating("");
    setDraftPath("");
    await reloadTree();
  }

  async function renameCurrent(event: React.FormEvent) {
    event.preventDefault();
    if (!openFile) return;
    const next = draftPath.trim();
    const saved = await api("/api/move", { method: "POST", body: { workspace, from: openFile.path, to: next } });
    setFiles((list) => list.map((file) => file.path === openFile.path ? { ...file, path: saved.path } : file));
    setCurrent(saved.path);
    setCreating("");
    await reloadTree();
  }

  async function deleteCurrent() {
    if (!openFile) return;
    await api(`/api/file?workspace=${encodeURIComponent(workspace)}&path=${encodeURIComponent(openFile.path)}`, { method: "DELETE" });
    setFiles((list) => list.filter((file) => file.path !== openFile.path));
    setCurrent("");
    setCreating("");
    await reloadTree();
  }

  async function runTerminal(event: React.FormEvent) {
    event.preventDefault();
    const line = command.trim();
    if (!line) return;
    setCommand("");
    try {
      const result = await api("/api/terminal", { method: "POST", body: { workspace, command: line } });
      setTerminal((list) => [...list, { command: line, output: result.output || "（没有输出）", code: result.code }]);
    } catch (reason: any) {
      setTerminal((list) => [...list, { command: line, output: reason.message, code: -1 }]);
    }
  }

  async function explore(relative: string) {
    try {
      await api("/api/explore", { method: "POST", body: { workspace, path: relative } });
      setError("");
    } catch (reason: any) {
      setError(reason.message);
    }
  }

  function quoteCurrent(relative: string) {
    const editor = document.querySelector("textarea[aria-label='文件内容']");
    const selected = editor instanceof HTMLTextAreaElement
      ? editor.value.slice(editor.selectionStart, editor.selectionEnd) || editor.value
      : openFile?.content || "";
    onQuote?.(quoteSnippet(relative, selected));
  }

  function openBrowser(event: React.FormEvent) {
    event.preventDefault();
    const value = address.trim();
    if (!value) return;
    if (/^https?:\/\//i.test(value)) setBrowserUrl(value);
    else setBrowserUrl(`/api/raw?workspace=${encodeURIComponent(workspace)}&path=${encodeURIComponent(value)}`);
  }

  const visibleTree = useMemo(() => filterTree(tree, query), [tree, query]);

  return (
    <aside className={desk.fullscreen ? "results fullscreen" : "results"}>
      <TabStrip
        tabs={desk.tabs}
        activeId={desk.activeId}
        fullscreen={desk.fullscreen}
        onActivate={desk.activate}
        onClose={desk.close}
        onOpenNew={desk.openNew}
        onToggleFullscreen={desk.toggleFullscreen}
        onCloseOthers={desk.closeOthers}
        onCloseRight={desk.closeToTheRight}
      />
      {error && <p className="fail">{error}</p>}
      {tab === "picker" && (
        <NewTabPicker
          hasChanges={changes.length > 0}
          artifacts={artifacts}
          onChoose={(kind, payload) => {
            desk.choose(kind, undefined, payload);
            if (kind === "artifacts" && payload) showArtifact(payload);
          }}
        />
      )}
      {tab === "artifacts" && (
        <div className="pane desk">
          <div className="sheet-list">
            <div className="sheet-label">产物{artifacts.length ? ` (${artifacts.length})` : ""}</div>
            {artifacts.length === 0 && <p className="empty">还没有产物。任务写完文件后会出现在这里。</p>}
            {artifacts.map((artifact: any) => {
              const bits = fileBits(artifact.path);
              const selected = preview?.path === artifact.path;
              return (
                <button type="button" data-testid="artifact" key={artifact.path} className="sheet-row" aria-pressed={selected} title={artifact.path} onClick={() => showArtifact(artifact.path)}>
                  <i className={`type-mark ${bits.kind}`}>{bits.ext}</i>
                  <span>{bits.name}</span>
                </button>
              );
            })}
          </div>
          <div className="sheet" data-testid="preview">
            {!preview && <p className="empty">选择一个产物查看内容。</p>}
            {preview && (
              <>
                <div className="sheet-bar">
                  <div className="sheet-title">
                    <strong>{fileBits(preview.path).name}</strong>
                    <span>{preview.path}</span>
                  </div>
                  <button type="button" onClick={() => explore(preview.path)}>打开文件夹</button>
                </div>
                <div className="sheet-body">
                  <FileView workspace={workspace} file={preview} />
                </div>
              </>
            )}
          </div>
        </div>
      )}
      {tab === "files" && (
        <div className="pane file-workspace">
          <div className="file-tree" data-testid="file-tree">
            <input aria-label="搜索文件" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索文件" />
            <div className="file-actions">
              <button type="button" onClick={() => { setCreating("file"); setDraftPath(""); }}>新建文件</button>
              <button type="button" onClick={() => { setCreating("dir"); setDraftPath(""); }}>新建文件夹</button>
            </div>
            {creating && (
              <form onSubmit={createEntry}>
                <input aria-label={creating === "dir" ? "新文件夹路径" : "新文件路径"} value={draftPath} onChange={(event) => setDraftPath(event.target.value)} placeholder={creating === "dir" ? "notes" : "notes/记录.md"} />
                <button type="submit">创建</button>
              </form>
            )}
            {visibleTree.length === 0 && <p className="empty">工作区里还没有文件。</p>}
            <TreeNodes nodes={visibleTree} onOpen={(filePath) => openPath(filePath).catch((reason) => setError(reason.message))} />
          </div>
          <div className="editor">
            <div className="open-tabs">
              {files.map((file) => (
                <button type="button" key={file.path} aria-pressed={file.path === current} onClick={() => setCurrent(file.path)}>{file.path.split("/").pop()}</button>
              ))}
            </div>
            {!openFile && <p className="empty">从左侧打开文件。文本文件可以在这里修改并保存。</p>}
            {openFile && (
              <>
                <div className="sheet-bar">
                  <div className="sheet-title">
                    <strong>{fileBits(openFile.path).name}</strong>
                    <span>{openFile.path}</span>
                  </div>
                  <div className="sheet-actions">
                    <button type="button" onClick={() => openPath(openFile.path, true)}>刷新</button>
                    <button type="button" onClick={() => save()} disabled={openFile.kind !== "text" && openFile.kind !== "html"}>保存</button>
                    <button type="button" onClick={() => { setCreating("rename"); setDraftPath(openFile.path); }}>重命名</button>
                    <button type="button" onClick={() => { setCreating("saveas"); setDraftPath(openFile.path); }}>另存为</button>
                    <button type="button" onClick={() => setCreating("delete")}>删除</button>
                    <button type="button" onClick={() => explore(openFile.path)}>打开文件夹</button>
                    {onQuote && <button type="button" onClick={() => quoteCurrent(openFile.path)}>引用</button>}
                    {(openFile.kind === "html" || openFile.kind === "image") && (
                      <button type="button" onClick={() => { setAddress(openFile.path); setBrowserUrl(`/api/raw?workspace=${encodeURIComponent(workspace)}&path=${encodeURIComponent(openFile.path)}`); desk.activate("browser"); }}>浏览器打开</button>
                    )}
                  </div>
                </div>
                {creating === "rename" && (
                  <form onSubmit={renameCurrent} className="inline-form">
                    <input aria-label="重命名为" value={draftPath} onChange={(event) => setDraftPath(event.target.value)} />
                    <button type="submit">确定</button>
                  </form>
                )}
                {creating === "saveas" && (
                  <form className="inline-form" onSubmit={(event) => { event.preventDefault(); save(draftPath.trim(), openFile.content, undefined); setCreating(""); }}>
                    <input aria-label="另存为路径" value={draftPath} onChange={(event) => setDraftPath(event.target.value)} />
                    <button type="submit">保存副本</button>
                  </form>
                )}
                {creating === "delete" && (
                  <div className="inline-form">
                    <span>删除 {openFile.path}？</span>
                    <button type="button" onClick={deleteCurrent}>确认删除</button>
                  </div>
                )}
                {openFile.notice && <p className="fail">{openFile.notice}</p>}
                {(openFile.kind === "text" || openFile.kind === "html") && (
                  <textarea aria-label="文件内容" value={openFile.content} onChange={(event) => updateCurrent(event.target.value)} onKeyDown={(event) => {
                    if (event.key === "s" && event.ctrlKey) {
                      event.preventDefault();
                      save();
                    }
                  }} />
                )}
                {openFile.kind !== "text" && openFile.kind !== "html" && <FileView workspace={workspace} file={openFile} />}
              </>
            )}
          </div>
        </div>
      )}
      {tab === "changes" && (
        <div className="pane desk">
          <div className="sheet-list">
            <div className="sheet-label">变更{changes.length ? ` (${changes.length})` : ""}</div>
            {changes.length === 0 && <p className="empty">这次任务还没有修改文件。</p>}
            {changes.map((change, index) => {
              const bits = fileBits(change.path);
              return (
                <button type="button" className="sheet-row" key={`${change.path}-${index}`} aria-pressed={selectedChange === index} title={change.path} onClick={() => setSelectedChange(index)}>
                  <i className={`type-mark ${bits.kind}`}>{bits.ext}</i>
                  <span>{bits.name}</span>
                  <em className={change.action === "modified" ? "is-edit" : "is-new"}>{change.action === "modified" ? "修改" : "新建"}</em>
                </button>
              );
            })}
          </div>
          <div className="sheet diff" data-testid="diff">
            {changes[selectedChange] && <DiffView change={changes[selectedChange]} />}
          </div>
        </div>
      )}
      {tab === "browser" && (
        <div className="pane desk">
          <div className="desk-head"><h2>浏览器</h2></div>
          <form className="inline-form" onSubmit={openBrowser}>
            <input aria-label="浏览器地址" value={address} onChange={(event) => setAddress(event.target.value)} placeholder="output/page.html 或 https:// 地址" />
            <button type="submit">打开</button>
          </form>
          {browserUrl && <iframe title="浏览器" sandbox="allow-scripts allow-forms" src={browserUrl} />}
          {!browserUrl && <p className="empty">打开工作区里的网页，或输入一个 http 地址。</p>}
        </div>
      )}
      {tab === "terminal" && (
        <div className="pane desk">
          <div className="desk-head"><h2>终端</h2></div>
          <p className="empty">命令在当前工作区目录执行，不能跳到目录外面。</p>
          <form className="inline-form" onSubmit={runTerminal}>
            <input aria-label="终端命令" value={command} onChange={(event) => setCommand(event.target.value)} placeholder="例如 node -v" />
            <button type="submit">运行</button>
          </form>
          <div className="terminal-log">
            {terminal.map((item, index) => (
              <article key={index}>
                <strong>$ {item.command}</strong>
                <pre>{item.output}{item.code !== 0 ? `\n退出码 ${item.code}` : ""}</pre>
              </article>
            ))}
          </div>
        </div>
      )}
    </aside>
  );
}

function TreeNodes({ nodes, onOpen }: { nodes: TreeNode[]; onOpen: (path: string) => void }) {
  return nodes.map((node) => node.type === "dir" ? (
    <details key={node.path} open>
      <summary>{node.name}</summary>
      <TreeNodes nodes={node.children || []} onOpen={onOpen} />
    </details>
  ) : (
    <button type="button" key={node.path} onClick={() => onOpen(node.path)}>{node.name}</button>
  ));
}

function FileView({ workspace, file }: { workspace: string; file: { path: string; kind: string; content?: string } }) {
  if (file.kind === "image") return <img alt={file.path} src={rawUrl(workspace, file.path)} />;
  if (file.kind === "html") return <iframe title={file.path} sandbox="allow-scripts" src={rawUrl(workspace, file.path)} />;
  if (file.kind === "binary") return <p>这个文件不能按文本预览。</p>;
  const kind = file.path.endsWith(".md") ? "markdown" : file.path.endsWith(".csv") ? "csv" : "text";
  return <RichBody content={file.content || ""} kind={kind} />;
}

function DiffView({ change }: { change: Change }) {
  const rows = lineDiff(change.before, change.after);
  const added = rows.filter((row) => row.type === "add").length;
  const removed = rows.filter((row) => row.type === "del").length;
  const bits = fileBits(change.path);
  return (
    <>
      <div className="sheet-bar">
        <i className={`type-mark ${bits.kind}`}>{bits.ext}</i>
        <div className="sheet-title">
          <strong>{bits.name}</strong>
          <span>{change.path}</span>
        </div>
        <span className="diff-stat"><b>+{added}</b><b>-{removed}</b></span>
      </div>
      <div className="diff-lines">
        {rows.map((row, index) => <div key={index} className={row.type === "add" ? "diff-add" : row.type === "del" ? "diff-del" : "diff-same"}>{row.type === "add" ? "+ " : row.type === "del" ? "- " : "  "}{row.line}</div>)}
      </div>
    </>
  );
}

function lineDiff(before: string | null, after: string | null) {
  const left = before == null ? [] : before.split(/\r?\n/);
  const right = (after || "").split(/\r?\n/);
  if (left.length + right.length > 240) {
    return right.slice(0, 80).map((line) => ({ type: "add" as const, line }));
  }
  const dp = Array.from({ length: left.length + 1 }, () => new Array<number>(right.length + 1).fill(0));
  for (let i = left.length - 1; i >= 0; i -= 1) {
    for (let j = right.length - 1; j >= 0; j -= 1) dp[i][j] = left[i] === right[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  }
  const rows: Array<{ type: "add" | "del" | "same"; line: string }> = [];
  let i = 0;
  let j = 0;
  while (i < left.length && j < right.length) {
    if (left[i] === right[j]) {
      rows.push({ type: "same", line: left[i] });
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      rows.push({ type: "del", line: left[i] });
      i += 1;
    } else {
      rows.push({ type: "add", line: right[j] });
      j += 1;
    }
  }
  while (i < left.length) rows.push({ type: "del", line: left[i++] });
  while (j < right.length) rows.push({ type: "add", line: right[j++] });
  return rows;
}

function filterTree(nodes: TreeNode[], query: string): TreeNode[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return nodes;
  return nodes.flatMap((node) => {
    if (node.type === "file") return node.path.toLowerCase().includes(needle) ? [node] : [];
    const children = filterTree(node.children || [], needle);
    return children.length ? [{ ...node, children }] : [];
  });
}

function fileBits(filePath: string) {
  const name = String(filePath || "").split(/[/\\]/).filter(Boolean).pop() || filePath;
  const raw = name.includes(".") ? name.split(".").pop()!.slice(0, 4).toUpperCase() : "FILE";
  const kind = raw === "PY" ? "py" : raw === "HTML" || raw === "HTM" ? "web" : raw === "PNG" || raw === "JPG" || raw === "GIF" ? "img" : raw === "JSON" || raw === "CSV" ? "data" : "doc";
  return { name, ext: raw.slice(0, 3), kind };
}

function rawUrl(workspace: string, relative: string) {
  return `/api/raw?workspace=${encodeURIComponent(workspace)}&path=${encodeURIComponent(relative)}`;
}
