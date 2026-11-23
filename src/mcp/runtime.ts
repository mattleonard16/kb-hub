import { join, resolve } from "node:path";
import { loadKnowledge } from "../index/load.ts";
import { KnowledgeStore } from "../index/store.ts";

/** Holds the current index and swaps it atomically on reload (after a merge or a webhook). */
export class StoreHolder {
  private store: KnowledgeStore;
  private constructor(
    readonly root: string,
    store: KnowledgeStore,
  ) {
    this.store = store;
  }

  static async open(root: string): Promise<StoreHolder> {
    const abs = resolve(root);
    return new StoreHolder(abs, new KnowledgeStore(await loadKnowledge(abs)));
  }

  get current(): KnowledgeStore {
    return this.store;
  }

  async reload(): Promise<{ concepts: number; invalid: string[] }> {
    const k = await loadKnowledge(this.root);
    this.store = new KnowledgeStore(k);
    return { concepts: k.concepts.length, invalid: k.invalid };
  }
}

/** Local state (audit log, kill switch) lives outside the knowledge repo so it is never committed. */
export function localStateDir(env = process.env): string {
  return env.KB_STATE_DIR ?? join(env.HOME ?? ".", ".kb");
}
