// Runs full model validation (including pose sampling with physics, which takes a while on big models) off the
// editor server's main thread, so edits and file requests never wait for it.
import { parentPort } from "node:worker_threads";
import { normalizeModel, validateModel } from "../core/index.ts";

parentPort!.on("message", (msg: { id: number; text: string; baseDir: string }) => {
  try {
    const issues = validateModel(normalizeModel(JSON.parse(msg.text)), { baseDir: msg.baseDir });
    parentPort!.postMessage({ id: msg.id, issues });
  } catch (e) {
    parentPort!.postMessage({ id: msg.id, error: (e as Error).message });
  }
});
