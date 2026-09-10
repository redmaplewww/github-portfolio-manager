import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

type CacheRecord = {
  storedAt: number;
  value: unknown;
};

type CacheFile = Record<string, CacheRecord>;

const inFlight = new Map<string, Promise<unknown>>();
let writeChain = Promise.resolve();

function cacheDirectory() {
  return process.env.GITHUB_PORTFOLIO_CACHE_DIR
    || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "Codex", "github-portfolio-manager");
}

function cachePath() {
  return path.join(cacheDirectory(), "web-cache.json");
}

async function readCache(): Promise<CacheFile> {
  try { return JSON.parse(await readFile(cachePath(), "utf8")) as CacheFile; } catch { return {}; }
}

async function writeCacheFile(value: CacheFile) {
  await mkdir(cacheDirectory(), { recursive: true });
  const temporary = `${cachePath()}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, cachePath());
}

async function mutateCache(mutator: (value: CacheFile) => boolean) {
  const task = writeChain.then(async () => {
    const value = await readCache();
    if (mutator(value)) await writeCacheFile(value);
  });
  writeChain = task.catch(() => undefined);
  await task;
}

function keyFor(key: string, params?: unknown) {
  return params === undefined ? key : `${key}:${JSON.stringify(params)}`;
}

function revalidate<T>(cacheKey: string, loader: () => Promise<T>): Promise<T> {
  const request = loader().then(async (value) => {
    await mutateCache((latest) => {
      latest[cacheKey] = { storedAt: Date.now(), value };
      return true;
    });
    return value;
  });
  inFlight.set(cacheKey, request);
  return request.finally(() => { inFlight.delete(cacheKey); });
}

export async function cached<T>(key: string, ttlMs: number, loader: () => Promise<T>, staleMs = 24 * 60 * 60 * 1000): Promise<{ value: T; cached: boolean; ageMs: number }> {
  const cacheKey = keyFor(key);
  const now = Date.now();
  const file = await readCache();
  const existing = file[cacheKey];
  if (existing && now - existing.storedAt <= ttlMs) {
    return { value: existing.value as T, cached: true, ageMs: now - existing.storedAt };
  }

  // Beyond the TTL but still inside the stale window: serve the persisted
  // value immediately (e.g. right after a server restart) and refresh in the
  // background so the next request sees fresh data.
  if (existing && now - existing.storedAt <= staleMs) {
    const current = inFlight.get(cacheKey);
    if (!current) {
      void revalidate(cacheKey, loader).catch(() => undefined);
    }
    return { value: existing.value as T, cached: true, ageMs: now - existing.storedAt };
  }

  const current = inFlight.get(cacheKey);
  if (current) {
    const value = await current as T;
    return { value, cached: false, ageMs: 0 };
  }

  try {
    const value = await revalidate(cacheKey, loader);
    return { value, cached: false, ageMs: 0 };
  } catch (error) {
    if (existing) {
      return { value: existing.value as T, cached: true, ageMs: now - existing.storedAt };
    }
    throw error;
  }
}

export async function invalidateCache(prefixes: string[]) {
  await mutateCache((file) => {
    let changed = false;
    for (const key of Object.keys(file)) {
      if (prefixes.some((prefix) => key === prefix || key.startsWith(`${prefix}:`))) {
        delete file[key];
        changed = true;
      }
    }
    return changed;
  });
}

export function cacheInfo() {
  return { directory: cacheDirectory(), path: cachePath() };
}
