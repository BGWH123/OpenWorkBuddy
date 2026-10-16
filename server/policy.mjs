const BLOCKED = [
  /\bformat\b/i,
  /\bshutdown\b/i,
  /\bdiskpart\b/i,
  /\bmkfs\b/i,
  /\bcipher\b/i,
  /\breg\s+(add|delete|import)\b/i,
  /\bpowershell\b[\s\S]*-(enc|encodedcommand)\b/i,
  /\bRemove-Item\b[\s\S]*-Recurse\b/i,
  /\b(del|erase|rd|rmdir)\b[\s\S]*\/s\b/i,
  /\bInvoke-Expression\b/i,
  /\biex\b/i,
  /\bAdd-Type\b/i,
];

export function assertCommandAllowed(command) {
  const text = String(command || "").trim();
  if (!text) throw new Error("没有命令");
  if (text.length > 2000) throw new Error("命令过长");
  if (/\.\.[\\/]/.test(text)) throw new Error("命令不能跳到工作区外面");
  if (BLOCKED.some((pattern) => pattern.test(text))) throw new Error("这条命令不在本地执行范围内");
  return text;
}
