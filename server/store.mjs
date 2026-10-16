import fs from "node:fs";
import path from "node:path";

const EMPTY = {
  settings: {
    provider: "local",
    baseUrl: "https://api.openai.com/v1",
    apiKey: "",
    model: "gpt-4o-mini",
    extraDirectories: [],
  },
  currentWorkspace: "",
  recentWorkspaces: [],
  tasks: [],
};

export function createStore(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  let state = readState(filePath);
  let chain = Promise.resolve();

  function snapshot() {
    return structuredClone(state);
  }

  function update(mutator) {
    const job = chain.then(() => {
      const draft = structuredClone(state);
      const next = mutator(draft) || draft;
      state = next;
      fs.writeFileSync(filePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
      return structuredClone(state);
    });
    chain = job.then(() => {}, () => {});
    return job;
  }

  return { snapshot, update, filePath };
}

function readState(filePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return {
      ...EMPTY,
      ...parsed,
      settings: { ...EMPTY.settings, ...(parsed.settings || {}) },
      recentWorkspaces: Array.isArray(parsed.recentWorkspaces) ? parsed.recentWorkspaces : [],
      tasks: Array.isArray(parsed.tasks) ? parsed.tasks : [],
    };
  } catch {
    return structuredClone(EMPTY);
  }
}

export function findTask(state, id) {
  return state.tasks.find((task) => task.id === id) || null;
}
