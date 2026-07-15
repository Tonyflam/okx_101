import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { StorySpec } from "./types.js";
import { isValidStoryId } from "./util.js";

/**
 * Story persistence: JSON spec + rendered HTML on disk, with a small
 * in-memory LRU in front. No external database — zero deploy friction.
 */
export class StoryStore {
  private dir: string;
  private cache = new Map<string, { spec: StorySpec; html: string }>();
  private readonly cacheMax = 100;

  constructor(dataDir: string) {
    this.dir = join(dataDir, "stories");
    mkdirSync(this.dir, { recursive: true });
  }

  save(spec: StorySpec, html: string): void {
    if (!isValidStoryId(spec.id)) throw new Error("invalid story id");
    writeFileSync(join(this.dir, `${spec.id}.json`), JSON.stringify(spec), "utf8");
    writeFileSync(join(this.dir, `${spec.id}.html`), html, "utf8");
    this.remember(spec.id, { spec, html });
  }

  getHtml(id: string): string | null {
    const hit = this.load(id);
    return hit ? hit.html : null;
  }

  getSpec(id: string): StorySpec | null {
    const hit = this.load(id);
    return hit ? hit.spec : null;
  }

  count(): number {
    try {
      return readdirSync(this.dir).filter((f) => f.endsWith(".json")).length;
    } catch {
      return 0;
    }
  }

  private load(id: string): { spec: StorySpec; html: string } | null {
    if (!isValidStoryId(id)) return null;
    const cached = this.cache.get(id);
    if (cached) return cached;
    const jsonPath = join(this.dir, `${id}.json`);
    const htmlPath = join(this.dir, `${id}.html`);
    if (!existsSync(jsonPath) || !existsSync(htmlPath)) return null;
    try {
      const spec = JSON.parse(readFileSync(jsonPath, "utf8")) as StorySpec;
      const html = readFileSync(htmlPath, "utf8");
      this.remember(id, { spec, html });
      return { spec, html };
    } catch {
      return null;
    }
  }

  private remember(id: string, entry: { spec: StorySpec; html: string }): void {
    this.cache.delete(id);
    this.cache.set(id, entry);
    while (this.cache.size > this.cacheMax) {
      const oldest = this.cache.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }
}
