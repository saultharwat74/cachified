import type {
  CachifiedOptions,
  Cache,
  CacheEntry,
  CacheMetadata,
} from './common';
import { CACHE_EMPTY, getCachedValue } from './getCachedValue';
import { getFreshValue } from './getFreshValue';
import { shouldRefresh } from './shouldRefresh';

// This is to prevent requesting multiple fresh values in parallel
// while revalidating or getting first value
// Keys are unique per cache but may be used by multiple caches
const pendingValuesByCache = new WeakMap<Cache<any>, Map<string, any>>();

export async function cachified<Value>(
  options: CachifiedOptions<Value>,
): Promise<Value> {
  const {
    key,
    cache,
    ttl,
    forceFresh,
    staleWhileRevalidate = 0,
    reporter = () => () => {},
  } = options;
  const metadata: CacheMetadata = {
    ttl: ttl ?? null,
    swv: staleWhileRevalidate === Infinity ? null : staleWhileRevalidate,
    createdTime: Date.now(),
  };
  const report = reporter(key, metadata);

  // Register this cache
  if (!pendingValuesByCache.has(cache)) {
    pendingValuesByCache.set(cache, new Map());
  }
  const pendingValues: Map<
    string,
    CacheEntry<Promise<Value>> & { resolve: (value: Value) => void }
  > = pendingValuesByCache.get(cache)!;

  const cachedValue =
    (!forceFresh && (await getCachedValue(options, report))) || CACHE_EMPTY;
  if (cachedValue !== CACHE_EMPTY) {
    return cachedValue;
  }

  if (pendingValues.has(key)) {
    const { value: pendingRefreshValue, metadata } = pendingValues.get(key)!;
    if (!shouldRefresh(metadata)) {
      report({ name: 'getFreshValueHookPending' });
      return pendingRefreshValue;
    }
  }

  let resolveFromFuture: (value: Value) => void;
  const freshValue = Promise.race([
    // try to get a fresh value
    getFreshValue(options, metadata, report),
    // or when a future call is faster, we'll take it's value
    // this happens when getting value of first call takes longer then ttl + second response
    new Promise<Value>((r) => {
      resolveFromFuture = r;
    }),
  ]).finally(() => {
    pendingValues.delete(key);
  });

  // here we inform past calls that we got a response
  if (pendingValues.has(key)) {
    const { resolve } = pendingValues.get(key)!;
    freshValue.then((value) => resolve(value));
  }

  pendingValues.set(key, {
    metadata,
    value: freshValue,
    // here we receive a fresh value from a future call
    resolve: resolveFromFuture!,
  });

  return freshValue;
}
