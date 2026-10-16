export async function collectEntries(entries, limit = 200) {
  const found = [];
  for (const entry of entries) {
    if (found.length >= limit) break;
    await walkEntry(entry, "", found, limit);
  }
  return found;
}

async function walkEntry(entry, prefix, found, limit) {
  if (!entry || found.length >= limit) return;
  if (entry.isFile) {
    const file = await readFile(entry);
    found.push({ file, relativePath: `${prefix}${entry.name}` });
    return;
  }
  if (!entry.isDirectory) return;
  const children = await readAll(entry);
  const next = `${prefix}${entry.name}/`;
  for (const child of children) {
    if (found.length >= limit) break;
    await walkEntry(child, next, found, limit);
  }
}

function readFile(entry) {
  return new Promise((resolve, reject) => entry.file(resolve, reject));
}

async function readAll(entry) {
  const reader = entry.createReader();
  const all = [];
  while (true) {
    const batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
    if (!batch.length) break;
    all.push(...batch);
  }
  return all;
}
