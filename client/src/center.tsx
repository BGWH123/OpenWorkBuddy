import { useMemo, useState, type FormEvent, type JSX } from "react";

type ExpertKind = "expert" | "team";
type Tab = "experts" | "skills" | "library" | "connectors" | "notices";

type CenterScreenProps = {
  experts: Array<{ id: string; name: string; kind: ExpertKind; summary: string }>;
  skills: Array<{ id: string; name: string; summary: string }>;
  library: Array<{ path: string; name: string; folder: string }>;
  notices: Array<{ id: string; kind: string; title: string; text: string }>;
  onClose: () => void;
  onSummon: (expertId: string) => void;
  onUseSkill: (skillId: string) => void;
  onAttach: (path: string) => void;
  onCreateExpert: (input: { name: string; summary: string; kind: ExpertKind }) => Promise<void> | void;
  onCreateSkill: (input: { name: string; summary: string }) => Promise<void> | void;
  onCreateNote: (input: { name: string; content: string }) => Promise<void> | void;
  onOpenNotice: (taskId: string) => void;
};

const TABS: Array<{ id: Tab; label: string }> = [
  { id: "experts", label: "专家" },
  { id: "skills", label: "技能" },
  { id: "library", label: "资料" },
  { id: "connectors", label: "连接器" },
  { id: "notices", label: "消息" },
];

const CLOSED_CONNECTORS = ["腾讯文档", "企业微信", "邮箱", "会议"];

const searchBox = {
  width: "100%",
  border: "1px solid var(--line)",
  borderRadius: 8,
  padding: "8px 10px",
  background: "#fff",
} as const;

const card = {
  border: "1px solid var(--line)",
  borderRadius: 12,
  background: "var(--panel)",
  padding: 12,
  display: "flex",
  flexDirection: "column",
  gap: 6,
} as const;

const connectorRow = {
  width: "100%",
  justifyContent: "space-between",
  alignItems: "center",
  border: "1px solid var(--line)",
  borderRadius: 8,
  padding: "8px 10px",
  background: "var(--panel)",
} as const;

function kindLabel(kind: ExpertKind): string {
  return kind === "team" ? "专家团" : "专家";
}

function matches(query: string, parts: string[]): boolean {
  const needle = query.trim().toLocaleLowerCase("zh-CN");
  if (!needle) return true;
  return parts.join("\n").toLocaleLowerCase("zh-CN").includes(needle);
}

function failureText(reason: unknown): string {
  return reason instanceof Error && reason.message ? reason.message : "操作没有完成";
}

export function CenterScreen(props: CenterScreenProps): JSX.Element {
  const [tab, setTab] = useState<Tab>("experts");
  const [expertQuery, setExpertQuery] = useState("");
  const [skillQuery, setSkillQuery] = useState("");
  const [expertName, setExpertName] = useState("");
  const [expertSummary, setExpertSummary] = useState("");
  const [expertKind, setExpertKind] = useState<ExpertKind>("expert");
  const [skillName, setSkillName] = useState("");
  const [skillSummary, setSkillSummary] = useState("");
  const [noteName, setNoteName] = useState("");
  const [noteBody, setNoteBody] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  const visibleExperts = useMemo(
    () => props.experts.filter((item) => matches(expertQuery, [item.name, item.summary, kindLabel(item.kind)])),
    [props.experts, expertQuery],
  );
  const visibleSkills = useMemo(
    () => props.skills.filter((item) => matches(skillQuery, [item.name, item.summary])),
    [props.skills, skillQuery],
  );

  function openTab(next: Tab) {
    setTab(next);
    setError("");
  }

  async function submitExpert(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = expertName.trim();
    if (!name || busy) return;
    setBusy("expert");
    setError("");
    try {
      await props.onCreateExpert({ name, summary: expertSummary.trim(), kind: expertKind });
      setExpertName("");
      setExpertSummary("");
      setExpertKind("expert");
    } catch (reason) {
      setError(failureText(reason));
    } finally {
      setBusy("");
    }
  }

  async function submitSkill(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = skillName.trim();
    if (!name || busy) return;
    setBusy("skill");
    setError("");
    try {
      await props.onCreateSkill({ name, summary: skillSummary.trim() });
      setSkillName("");
      setSkillSummary("");
    } catch (reason) {
      setError(failureText(reason));
    } finally {
      setBusy("");
    }
  }

  async function submitNote(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = noteName.trim();
    if (!name || busy) return;
    setBusy("note");
    setError("");
    try {
      await props.onCreateNote({ name, content: noteBody });
      setNoteName("");
      setNoteBody("");
    } catch (reason) {
      setError(failureText(reason));
    } finally {
      setBusy("");
    }
  }

  return (
    <section className="results" style={{ height: "100%", minHeight: 0 }}>
      <header className="conversation-head">
        <h2>专家 · 技能 · 连接器</h2>
        <button type="button" onClick={props.onClose}>关闭</button>
      </header>
      <div className="tabs" role="tablist" aria-label="专家、技能、资料、连接器和消息">
        {TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            id={`center-tab-${item.id}`}
            aria-controls="center-panel"
            aria-selected={tab === item.id}
            aria-pressed={tab === item.id}
            style={item.id === "notices" ? { fontSize: 13, padding: "4px 8px" } : undefined}
            onClick={() => openTab(item.id)}
          >
            {item.label}
            {item.id === "notices" && props.notices.length > 0 ? ` ${props.notices.length}` : ""}
          </button>
        ))}
      </div>
      <div
        className="pane"
        id="center-panel"
        role="tabpanel"
        aria-labelledby={`center-tab-${tab}`}
        style={{ flex: 1, minHeight: 0 }}
      >
        {error ? <p className="fail" style={{ margin: 0 }} role="alert">{error}</p> : null}
        {tab === "experts" ? (
          <>
            <input
              aria-label="搜索专家"
              type="search"
              value={expertQuery}
              style={searchBox}
              onChange={(event) => setExpertQuery(event.target.value)}
            />
            {props.experts.length === 0 ? <p className="empty">还没有专家</p> : null}
            {props.experts.length > 0 && visibleExperts.length === 0 ? <p className="empty">没有匹配的专家</p> : null}
            {visibleExperts.map((expert) => (
              <article key={expert.id} style={card}>
                <strong>{expert.name}</strong>
                <span className="empty">{kindLabel(expert.kind)}</span>
                <p>{expert.summary}</p>
                <div className="row">
                  <button type="button" className="primary" onClick={() => props.onSummon(expert.id)}>召唤</button>
                </div>
              </article>
            ))}
            <form className="dialog" onSubmit={submitExpert}>
              <h2>创建专家</h2>
              <label>
                名称
                <input value={expertName} required onChange={(event) => setExpertName(event.target.value)} />
              </label>
              <label>
                简介
                <input value={expertSummary} onChange={(event) => setExpertSummary(event.target.value)} />
              </label>
              <label>
                类型
                <select
                  value={expertKind}
                  aria-label="专家类型"
                  onChange={(event) => setExpertKind(event.target.value === "team" ? "team" : "expert")}
                >
                  <option value="expert">专家</option>
                  <option value="team">专家团</option>
                </select>
              </label>
              <button className="primary" type="submit" disabled={busy === "expert"}>创建专家</button>
            </form>
          </>
        ) : null}
        {tab === "skills" ? (
          <>
            <input
              aria-label="搜索技能"
              type="search"
              value={skillQuery}
              style={searchBox}
              onChange={(event) => setSkillQuery(event.target.value)}
            />
            {props.skills.length === 0 ? <p className="empty">还没有技能</p> : null}
            {props.skills.length > 0 && visibleSkills.length === 0 ? <p className="empty">没有匹配的技能</p> : null}
            {visibleSkills.map((skill) => (
              <article key={skill.id} style={card}>
                <strong>{skill.name}</strong>
                <p>{skill.summary}</p>
                <div className="row">
                  <button type="button" className="primary" onClick={() => props.onUseSkill(skill.id)}>使用技能</button>
                </div>
              </article>
            ))}
            <form className="dialog" onSubmit={submitSkill}>
              <h2>创建技能</h2>
              <label>
                名称
                <input value={skillName} required onChange={(event) => setSkillName(event.target.value)} />
              </label>
              <label>
                简介
                <input value={skillSummary} onChange={(event) => setSkillSummary(event.target.value)} />
              </label>
              <button className="primary" type="submit" disabled={busy === "skill"}>创建技能</button>
            </form>
          </>
        ) : null}
        {tab === "library" ? (
          <>
            {props.library.length === 0 ? <p className="empty">资料库还没有文件</p> : null}
            {props.library.map((item) => (
              <article key={item.path} style={card}>
                <strong>{item.name}</strong>
                <span className="empty">{item.folder}</span>
                <div className="row">
                  <button type="button" className="primary" onClick={() => props.onAttach(item.path)}>加入对话</button>
                </div>
              </article>
            ))}
            <form className="dialog" onSubmit={submitNote}>
              <h2>保存笔记</h2>
              <label>
                名称
                <input value={noteName} required onChange={(event) => setNoteName(event.target.value)} />
              </label>
              <label>
                正文
                <textarea aria-label="资料正文" value={noteBody} onChange={(event) => setNoteBody(event.target.value)} />
              </label>
              <button className="primary" type="submit" disabled={busy === "note"}>保存到资料</button>
            </form>
          </>
        ) : null}
        {tab === "connectors" ? (
          <>
            <div className="row" style={connectorRow}>
              <span className="row" style={{ alignItems: "center", margin: 0 }}>
                <strong>本机资料库</strong>
                <span style={{ color: "var(--accent)" }}>已接入</span>
              </span>
              <button type="button" className="primary" onClick={() => openTab("library")}>打开</button>
            </div>
            <p className="empty">需要官方账号，本地版不连接这些服务</p>
            {CLOSED_CONNECTORS.map((name) => (
              <div key={name} className="row" style={connectorRow}>
                <strong>{name}</strong>
                <span className="fail" style={{ margin: 0 }}>未接入</span>
              </div>
            ))}
          </>
        ) : null}
        {tab === "notices" ? (
          props.notices.length === 0 ? (
            <p className="empty">暂无消息</p>
          ) : (
            props.notices.map((notice) => (
              <button key={notice.id} type="button" onClick={() => props.onOpenNotice(notice.id)}>
                <strong>{notice.title}</strong>
                <span className="empty">{notice.kind}</span>
                <span>{notice.text}</span>
              </button>
            ))
          )
        ) : null}
      </div>
    </section>
  );
}
