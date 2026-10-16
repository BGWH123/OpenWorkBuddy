export function decodeBuffer(buffer) {
  const data = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
  if (!data.length) return "";
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch {
    try {
      return new TextDecoder("gbk").decode(data);
    } catch {
      return data.toString("utf8");
    }
  }
}
