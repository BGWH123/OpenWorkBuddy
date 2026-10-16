const FILE = "[^\\s，,。；;：:「」\"'`<>]+?\\.[A-Za-z0-9]{1,8}";

export function localPlan(instruction, meta = {}) {
  const lines = [
    "## 方案",
    "",
    `目标：${instruction}`,
    "",
    "1. 先查看工作区里已经有的文件，避免覆盖无关内容。",
    "2. 只在这个工作区内生成或修改完成任务所需的文件。",
    "3. 回复里写清产物路径；没有资料支撑的内容标成未确认。",
  ];
  if (meta.expert) lines.push("", `角色：按「${meta.expert.name}」的方法处理。`);
  if (meta.skill) lines.push("", `技能：使用「${meta.skill.name}」。`);
  lines.push("", "未确认前不会修改文件。");
  return lines.join("\n");
}

export function localComplete(transcript, tools, meta = {}) {
  const allowed = new Set(tools.map((tool) => tool.name));
  const writeName = allowed.has("Write") ? "Write" : "write_file";
  const readName = allowed.has("Read") ? "Read" : "read_file";
  const searchName = allowed.has("Grep") ? "Grep" : "search_text";
  const listName = allowed.has("Glob") ? "Glob" : "list_dir";
  const commandName = allowed.has("Bash") ? "Bash" : "run_command";
  const instruction = String(meta.instruction || latestUser(transcript) || "").trim();
  const done = toolsSinceUser(transcript);
  const write = explicitWrite(instruction, meta);
  if (write) {
    if (!allowed.has(writeName)) return { content: "仅问答模式不会修改文件，也不会执行命令。" };
    if (!used(done, writeName)) {
      return call(writeName, {
        path: write.path,
        content: write.content ?? buildDocument(instruction, meta),
      });
    }
    return { content: `已写入 ${write.path}。` };
  }

  const command = instruction.match(/(?:执行命令|运行命令)\s*[:：]\s*([\s\S]+)/);
  if (command) {
    if (!allowed.has(commandName)) return { content: "仅问答模式不会执行命令，也不会修改文件。" };
    if (!used(done, commandName)) return call(commandName, { command: command[1].trim() });
    return { content: `命令已执行。\n\n${clip(done.find((item) => item.toolName === commandName)?.content || "")}` };
  }

  const read = instruction.match(new RegExp(`(?:读取|打开|查看)\\s*[「"'\`]?(${FILE})`));
  if (read) {
    if (!used(done, readName)) return call(readName, { path: normalize(read[1]) });
    return { content: done.find((item) => item.toolName === readName)?.content || "没有读到文件。" };
  }

  const search = instruction.match(/(?:搜索|查找)\s*[「"'`]?(.+?)\s*$/);
  if (search) {
    if (!allowed.has(searchName)) return { content: "当前模式不能搜索文件。" };
    if (!used(done, searchName)) return call(searchName, { pattern: search[1].trim(), query: search[1].trim() });
    const body = done.find((item) => item.toolName === searchName)?.content || "没有匹配。";
    return { content: `搜索结果：\n${body}` };
  }

  if (/(哪些文件|文件列表|列出文件|列出当前)/.test(instruction)) {
    if (!used(done, listName)) return call(listName, { path: ".", pattern: "" });
    return { content: `工作区里有这些文件：\n${done.find((item) => item.toolName === listName)?.content || ""}` };
  }

  if (meta.skill?.id === "file-organize" || /整理文件|整理当前|目录说明/.test(instruction)) {
    if (!used(done, listName)) return call(listName, { path: ".", pattern: "" });
    if (!allowed.has(writeName)) {
      return { content: `工作区里有这些文件：\n${done.find((item) => item.toolName === listName)?.content || ""}` };
    }
    if (!used(done, writeName)) {
      const listing = done.find((item) => item.toolName === listName)?.content || "";
      return call(writeName, { path: "output/目录说明.md", content: `# 目录说明\n\n${listing}\n` });
    }
    return { content: "已根据工作区文件写好 output/目录说明.md。" };
  }

  if (meta.skill?.id === "csv-table" || /表格|csv/i.test(instruction)) {
    if (!allowed.has(writeName)) return { content: "仅问答模式不会修改文件。" };
    if (!used(done, writeName)) {
      return call(writeName, { path: "output/table.csv", content: "项目,说明\n当前任务,本地模式没有补充外部数据\n" });
    }
    return { content: "已写入 output/table.csv。" };
  }

  if (/网页|html/i.test(instruction)) {
    if (!allowed.has(writeName)) return { content: "仅问答模式不会修改文件。" };
    if (!used(done, writeName)) {
      return call(writeName, {
        path: "output/page.html",
        content: `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>页面</title><body><h1>页面草稿</h1><p>${escapeHtml(instruction)}</p></body></html>`,
      });
    }
    return { content: "已写入 output/page.html。" };
  }

  if (/(写一份|生成一份|做一份|生成文档|写个文档)/.test(instruction)) {
    if (!allowed.has(writeName)) return { content: "仅问答模式不会修改文件。我可以根据已读到的内容回答。" };
    if (!used(done, writeName)) {
      return call(writeName, { path: "output/交付.md", content: buildDocument(instruction, meta) });
    }
    return { content: "已写入 output/交付.md。" };
  }

  if (done.length) return { content: done.map((item) => item.content).join("\n\n") };
  return {
    content: [
      "本地模式没有连接外部模型，不会编造外部资料。",
      "我可以列出、读取、搜索工作区文件；在默认模式或已确认的计划里，也可以写入 Markdown、CSV、HTML，或在工作区目录执行命令。",
      "",
      `你刚才说：${instruction}`,
    ].join("\n"),
  };
}

function explicitWrite(instruction, meta) {
  const change = instruction.match(new RegExp(`(?:把|将)\\s*[「"'\`]?(${FILE})[」"'\`]?[\\s\\S]*?(?:改成|修改为|内容改为)\\s*([\\s\\S]+)`));
  if (change) return { path: normalize(change[1]), content: change[2].trim() };
  const named = instruction.match(new RegExp(`(?:创建|新建|写入)(?:一个)?(?:文件)?\\s*[：:]?\\s*[「"'\`]?(${FILE})`));
  const saveAs = instruction.match(new RegExp(`保存为\\s*[「"'\`]?(${FILE})`));
  const found = named?.[1] || saveAs?.[1];
  if (!found && meta.lastArtifact && /改成|修改为|内容改为/.test(instruction)) {
    const content = instruction.match(/(?:改成|修改为|内容改为)\s*([\s\S]+)/);
    return { path: meta.lastArtifact, content: content ? content[1].trim() : "" };
  }
  if (!found) return null;
  const content = instruction.match(/内容(?:是|为)\s*([\s\S]+)/);
  return { path: normalize(found), content: content ? content[1].trim() : null };
}

function buildDocument(instruction, meta) {
  const lines = ["# 交付稿", "", "## 任务", instruction];
  if (meta.expert?.kind === "team" && meta.expert.members?.length) {
    for (const member of meta.expert.members) {
      lines.push("", `## ${member}`);
      lines.push(member === "校对"
        ? "只保留任务中已经给出的信息。没有外部资料，不把猜测写成结论。"
        : "围绕任务整理已有信息，不补充未经确认的事实。");
    }
  } else if (meta.expert) {
    lines.push("", "## 处理方式", meta.expert.summary || meta.expert.name, "", "## 未确认", "本地模式没有查询外部资料。");
  }
  lines.push("", "## 说明", "这是本地模式生成的稿件，没有查询外部资料。");
  return lines.join("\n");
}

function call(name, args) {
  return { content: "", toolCalls: [{ id: `call_${name}`, name, arguments: args }] };
}

function latestUser(transcript) {
  return [...transcript].reverse().find((item) => item.role === "user")?.content || "";
}

function toolsSinceUser(transcript) {
  let start = -1;
  for (let index = transcript.length - 1; index >= 0; index -= 1) {
    if (transcript[index].role === "user") {
      start = index;
      break;
    }
  }
  return transcript.slice(start + 1).filter((item) => item.role === "tool");
}

function used(messages, name) {
  const groups = [["Write", "write_file"], ["Glob", "list_dir"], ["Read", "read_file"], ["Grep", "search_text"], ["Bash", "run_command"]];
  const group = groups.find((item) => item.includes(name)) || [name];
  return messages.some((item) => group.includes(item.toolName));
}

function normalize(input) {
  return String(input || "").replaceAll("\\", "/").replace(/^\.\/+/, "");
}

function clip(text) {
  const value = String(text || "");
  return value.length > 4000 ? `${value.slice(0, 4000)}\n…` : value;
}

function escapeHtml(text) {
  return String(text).replace(/[&<>]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[char]));
}
