type TalkMessage = { role: string; content: string; toolName?: string };
type TalkTask = {
  title: string;
  mode: string;
  status: string;
  messages: TalkMessage[];
  artifacts: Array<{ path: string }>;
};

const HIDDEN = "[已隐藏]";

export function messagePlainText(task: { messages?: Array<{ content?: string }> }): string {
  return (task.messages || []).map((message) => message.content || "").join("\n");
}

export function userQuestions(messages: Array<{ role: string; content: string }>): Array<{ index: number; text: string }> {
  const questions: Array<{ index: number; text: string }> = [];
  (messages || []).forEach((message, index) => {
    if (!message || message.role !== "user") return;
    const text = String(message.content || "").split(/\r?\n/, 1)[0].slice(0, 80);
    questions.push({ index, text });
  });
  return questions;
}

export function shareMarkdown(task: TalkTask): string {
  const messages = (task.messages || []).map((message) => {
    const body = hideSecrets(message.content || "");
    return `### ${speaker(message)}\n\n${body}`;
  });
  const paths = (task.artifacts || []).filter((item) => item && item.path).map((item) => `- ${item.path}`);
  const title = hideSecrets(String(task.title || "未命名任务").replace(/[\r\n]+/g, " "));
  return [
    `# ${title}`,
    "",
    `状态：${statusText(task.status)}`,
    `模式：${modeText(task.mode)}`,
    "",
    "## 消息",
    "",
    messages.join("\n\n") || "暂无消息",
    "",
    "## 产物",
    "",
    paths.join("\n") || "暂无产物",
    "",
  ].join("\n");
}

export function ConversationExtras(props: {
  messages: Array<{ role: string; content: string; toolName?: string }>;
  query: string;
  onQuery: (value: string) => void;
  onJump: (index: number) => void;
}) {
  const questions = userQuestions(props.messages);
  const visible = props.query ? questions.filter((item) => item.text.includes(props.query)) : questions;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, minWidth: 0 }}>
      <div className="row">
        <input
          className="primary"
          type="search"
          aria-label="搜索对话"
          placeholder="搜索这条对话"
          value={props.query}
          autoComplete="off"
          onChange={(event) => props.onQuery(event.target.value)}
          style={{ flex: "1 1 12rem", minWidth: 0 }}
        />
      </div>
      {visible.length === 0 ? <p className="empty">没有匹配的提问</p> : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {visible.map((item) => (
            <div key={item.index} className="message">
              <button
                type="button"
                className="path-link"
                onClick={() => props.onJump(item.index)}
                style={{ display: "block", width: "100%", textAlign: "left", minHeight: "1.2em" }}
              >
                {item.text}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function RichBody(props: { content: string; kind: "text" | "html" | "csv" | "markdown" }) {
  const content = String(props.content ?? "");
  if (props.kind === "html") {
    return (
      <div className="message">
        <p>网页请在浏览器页签打开</p>
        <pre>{content}</pre>
      </div>
    );
  }
  if (props.kind === "csv") return <CsvTable content={content} />;
  if (props.kind === "markdown" || (props.kind === "text" && looksLikeMarkdown(content))) return <MarkdownView content={content} />;
  return <pre>{content}</pre>;
}

export function quoteSnippet(path: string, text: string): string {
  const lines = String(text ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  const body = lines.slice(0, 30).map((line) => `> ${line}`).join("\n");
  const label = String(path ?? "").replace(/[\r\n]+/g, " ");
  return `引用 ${label}：\n${body}`;
}

function speaker(message: TalkMessage) {
  if (message.role === "user") return "你";
  if (message.role === "tool") return toolLabel(message.toolName);
  if (message.role === "system") return "系统";
  return "OpenWorkBuddy";
}

function toolLabel(name?: string) {
  const labels: Record<string, string> = {
    list_dir: "列出文件",
    read_file: "读取文件",
    search_text: "搜索",
    write_file: "写入文件",
    run_command: "执行命令",
  };
  if (!name) return "操作";
  return labels[name] || name;
}

function statusText(status: string) {
  if (status === "running") return "执行中";
  if (status === "awaiting_confirm") return "待确认";
  if (status === "done") return "已完成";
  if (status === "error") return "失败";
  return "进行中";
}

function modeText(mode: string) {
  if (mode === "agent") return "默认";
  if (mode === "plan") return "计划";
  if (mode === "ask") return "仅问答";
  return mode || "默认";
}

function hideSecrets(text: string) {
  return String(text || "")
    .replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g, HIDDEN)
    .replace(/\b(Bearer)\s+\S+/gi, `$1 ${HIDDEN}`)
    .replace(/\bsk-(?:proj-|ant-)?[A-Za-z0-9_\-]{8,}\b/g, HIDDEN)
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, HIDDEN)
    .replace(/\b(?:ghp|gho|github_pat)_[A-Za-z0-9_]{8,}\b/g, HIDDEN)
    .replace(/((?:api[_-]?key|apikey|secret|password|passwd|token|authorization)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|\S+)/gi, `$1${HIDDEN}`);
}

function looksLikeMarkdown(content: string) {
  return /(?:^|\n)#{1,6} \S/.test(content) || /(?:^|\n)- \S/.test(content) || /(?:^|\n)```/.test(content);
}

function MarkdownView({ content }: { content: string }) {
  const lines = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const blocks = [];
  let index = 0;
  let key = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (line.startsWith("```")) {
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !lines[index].startsWith("```")) {
        code.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push(<pre key={key}><code>{code.join("\n")}</code></pre>);
      key += 1;
      continue;
    }
    const heading = /^(#{1,6}) (.*)$/.exec(line);
    if (heading) {
      blocks.push(<Heading key={key} level={heading[1].length} text={heading[2]} />);
      key += 1;
      index += 1;
      continue;
    }
    if (line.startsWith("- ")) {
      const items: string[] = [];
      while (index < lines.length && lines[index].startsWith("- ")) {
        items.push(lines[index].slice(2));
        index += 1;
      }
      blocks.push(<ul key={key}>{items.map((item, itemIndex) => <li key={itemIndex}>{item}</li>)}</ul>);
      key += 1;
      continue;
    }
    if (line.trim() === "") {
      index += 1;
      continue;
    }
    const paragraph: string[] = [];
    while (index < lines.length && lines[index].trim() !== "" && !isBlockStart(lines[index])) {
      paragraph.push(lines[index]);
      index += 1;
    }
    blocks.push(<p key={key} style={{ whiteSpace: "pre-wrap" }}>{paragraph.join("\n")}</p>);
    key += 1;
  }
  return <>{blocks}</>;
}

function isBlockStart(line: string) {
  return line.startsWith("```") || line.startsWith("- ") || /^(#{1,6}) /.test(line);
}

function Heading({ level, text }: { level: number; text: string }) {
  if (level === 1) return <h1>{text}</h1>;
  if (level === 2) return <h2>{text}</h2>;
  if (level === 3) return <h3>{text}</h3>;
  if (level === 4) return <h4>{text}</h4>;
  if (level === 5) return <h5>{text}</h5>;
  return <h6>{text}</h6>;
}

function CsvTable({ content }: { content: string }) {
  const rows = parseCsv(content);
  const cell = { border: "1px solid #e4dcd0", padding: "4px 8px", verticalAlign: "top" as const };
  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ borderCollapse: "collapse", width: "100%" }}>
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {row.map((value, column) => <td key={column} style={cell}>{value}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function parseCsv(content: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const src = content.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  for (let i = 0; i < src.length; i += 1) {
    const char = src[i];
    if (quoted) {
      if (char === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
      continue;
    }
    if (char === ",") {
      row.push(field);
      field = "";
      continue;
    }
    if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      continue;
    }
    field += char;
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}
