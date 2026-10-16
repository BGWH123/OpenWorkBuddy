import { useRef, useState } from "react";

export type TabKind = "new" | "artifacts" | "files" | "changes" | "browser" | "terminal";

export type DeskTab = {
  id: string;
  kind: Exclude<TabKind, "new">;
  title: string;
  payload?: string;
};

type Desk = {
  tabs: DeskTab[];
  activeId: string;
  fullscreen: boolean;
};

function filesTab(): DeskTab {
  return { id: "files", kind: "files", title: "文件" };
}

function isPicker(tab: DeskTab) {
  return tab.kind === "artifacts" && tab.payload === "picker" && tab.title === "新标签页";
}

function fileTitle(payload: string) {
  const name = payload.split(/[/\\]/).filter(Boolean).pop();
  return name || "产物";
}

function fileBits(filePath: string) {
  const name = filePath.split(/[/\\]/).filter(Boolean).pop() || filePath;
  const raw = name.includes(".") ? name.split(".").pop()!.slice(0, 4).toUpperCase() : "FILE";
  const kind = raw === "PY" ? "py" : raw === "HTML" || raw === "HTM" ? "web" : raw === "PNG" || raw === "JPG" || raw === "GIF" ? "img" : raw === "JSON" || raw === "CSV" ? "data" : "doc";
  return { name, ext: raw.slice(0, 3), kind };
}

function describe(id: string, kind: DeskTab["kind"], title?: string, payload?: string): DeskTab {
  const given = title?.trim();
  const extra = payload && payload.trim() ? payload : undefined;
  let text = given || "";
  if (!text) {
    if (kind === "browser") text = extra || "浏览器";
    else if (kind === "terminal") text = extra || "终端";
    else if (kind === "artifacts") text = extra ? fileTitle(extra) : "产物";
    else if (kind === "files") text = "文件";
    else text = "变更";
  }
  const tab: DeskTab = { id, kind, title: text };
  if (extra !== undefined) tab.payload = extra;
  return tab;
}

function seedOf(initial?: DeskTab[]) {
  if (initial && initial.length > 0) return initial.map((tab) => ({ ...tab }));
  return [filesTab()];
}

function highest(tabs: DeskTab[]) {
  let max = 0;
  for (const tab of tabs) {
    const matched = /^tab-(\d+)$/.exec(tab.id);
    if (matched) max = Math.max(max, Number(matched[1]));
  }
  return max;
}

export function useDeskTabs(initial?: DeskTab[]) {
  const [desk, setDesk] = useState<Desk>(() => {
    const tabs = seedOf(initial);
    return { tabs, activeId: tabs[0].id, fullscreen: false };
  });
  const seq = useRef(highest(desk.tabs));

  function takeId(tabs: DeskTab[]) {
    const used = new Set(tabs.map((tab) => tab.id));
    let id = "";
    do {
      seq.current += 1;
      id = `tab-${seq.current}`;
    } while (used.has(id));
    return id;
  }

  function openNew() {
    setDesk((current) => {
      const tab: DeskTab = { id: takeId(current.tabs), kind: "artifacts", title: "新标签页", payload: "picker" };
      return { ...current, tabs: [...current.tabs, tab], activeId: tab.id };
    });
  }

  function activate(id: string) {
    setDesk((current) => (current.tabs.some((tab) => tab.id === id) ? { ...current, activeId: id } : current));
  }

  function close(id: string) {
    setDesk((current) => {
      const index = current.tabs.findIndex((tab) => tab.id === id);
      if (index < 0) return current;
      const tabs = current.tabs.filter((tab) => tab.id !== id);
      if (tabs.length === 0) {
        const next = filesTab();
        return { ...current, tabs: [next], activeId: next.id };
      }
      const activeId = current.activeId === id ? tabs[Math.min(index, tabs.length - 1)].id : current.activeId;
      return { ...current, tabs, activeId };
    });
  }

  function closeOthers(id: string) {
    setDesk((current) => {
      const kept = current.tabs.filter((tab) => tab.id === id);
      if (kept.length === 0) return current;
      return { ...current, tabs: kept, activeId: id };
    });
  }

  function closeToTheRight(id: string) {
    setDesk((current) => {
      const index = current.tabs.findIndex((tab) => tab.id === id);
      if (index < 0 || index >= current.tabs.length - 1) return current;
      const tabs = current.tabs.slice(0, index + 1);
      const activeId = tabs.some((tab) => tab.id === current.activeId) ? current.activeId : id;
      return { ...current, tabs, activeId };
    });
  }

  function choose(kind: DeskTab["kind"], title?: string, payload?: string) {
    setDesk((current) => {
      if (kind === "files" || kind === "changes") {
        const existing = current.tabs.find((tab) => tab.kind === kind);
        if (existing) return existing.id === current.activeId ? current : { ...current, activeId: existing.id };
      }
      const index = current.tabs.findIndex((tab) => tab.id === current.activeId);
      const active = index >= 0 ? current.tabs[index] : undefined;
      if (active && isPicker(active)) {
        const tabs = current.tabs.slice();
        tabs[index] = describe(active.id, kind, title, payload);
        return { ...current, tabs };
      }
      const tab = describe(takeId(current.tabs), kind, title, payload);
      return { ...current, tabs: [...current.tabs, tab], activeId: tab.id };
    });
  }

  function toggleFullscreen() {
    setDesk((current) => ({ ...current, fullscreen: !current.fullscreen }));
  }

  function setFullscreen(value: boolean) {
    setDesk((current) => (current.fullscreen === value ? current : { ...current, fullscreen: value }));
  }

  return {
    tabs: desk.tabs,
    activeId: desk.activeId,
    fullscreen: desk.fullscreen,
    openNew,
    activate,
    close,
    closeOthers,
    closeToTheRight,
    choose,
    toggleFullscreen,
    setFullscreen,
  };
}

export function TabStrip(props: {
  tabs: DeskTab[];
  activeId: string;
  fullscreen: boolean;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
  onOpenNew: () => void;
  onToggleFullscreen: () => void;
  onCloseOthers: (id: string) => void;
  onCloseRight: (id: string) => void;
}) {
  const [menuId, setMenuId] = useState<string | null>(null);
  const menuOpen = props.tabs.some((tab) => tab.id === menuId);

  return (
    <div className="tabs">
      <div className="row">
        {props.tabs.map((tab) => (
          <div
            key={tab.id}
            className="tab"
            onContextMenu={(event) => {
              event.preventDefault();
              setMenuId(tab.id);
            }}
          >
            <button type="button" className="tab-chip" aria-pressed={tab.id === props.activeId} onClick={() => props.onActivate(tab.id)}>
              {tab.title}
            </button>
            <button type="button" className="tab-close" aria-label={`关闭${tab.title}`} onClick={() => props.onClose(tab.id)}>
              ×
            </button>
            {menuOpen && menuId === tab.id && (
              <div className="tab-menu">
                <button type="button" onClick={() => { props.onCloseOthers(tab.id); setMenuId(null); }}>关闭其他</button>
                <button type="button" onClick={() => { props.onCloseRight(tab.id); setMenuId(null); }}>关闭右侧</button>
              </div>
            )}
          </div>
        ))}
        <button type="button" className="tab-add" aria-label="新标签页" onClick={props.onOpenNew}>+</button>
        <button type="button" className="tab-full" aria-label="全屏" aria-pressed={props.fullscreen} onClick={props.onToggleFullscreen}>全屏</button>
      </div>
    </div>
  );
}

export function NewTabPicker(props: {
  hasChanges: boolean;
  artifacts: Array<{ path: string }>;
  onChoose: (kind: "browser" | "files" | "changes" | "terminal" | "artifacts", payload?: string) => void;
}) {
  return (
    <div className="pane desk-picker">
      <button type="button" className="sheet-row" onClick={() => props.onChoose("browser")}>打开浏览器</button>
      <button type="button" className="sheet-row" onClick={() => props.onChoose("files")}>查看工作空间</button>
      <button type="button" className="sheet-row" onClick={() => props.onChoose("terminal")}>打开终端</button>
      {props.hasChanges && <button type="button" className="sheet-row" onClick={() => props.onChoose("changes")}>查看变更</button>}
      <div className="sheet-label">产物{props.artifacts.length ? ` (${props.artifacts.length})` : ""}</div>
      {props.artifacts.length === 0 && <p className="empty">暂无产物</p>}
      {props.artifacts.map((artifact, index) => {
        const bits = fileBits(artifact.path);
        return (
          <button type="button" className="sheet-row" key={`${artifact.path}\0${index}`} onClick={() => props.onChoose("artifacts", artifact.path)}>
            <i className={`type-mark ${bits.kind}`}>{bits.ext}</i>
            <span>{bits.name}</span>
          </button>
        );
      })}
    </div>
  );
}
