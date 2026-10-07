/**
 * Small LRU cache bounded by entry count and by total "size" (bytes for book texts).
 * Map keeps insertion order, so the first key is always the least recently used.
 */
export class LruCache<K, V> {
  private map = new Map<K, { value: V; size: number }>();
  private total = 0;

  constructor(
    private readonly maxEntries: number,
    private readonly maxSize = Number.POSITIVE_INFINITY,
    private readonly sizeOf: (value: V) => number = () => 1,
  ) {}

  get(key: K): V | undefined {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    this.map.delete(key);
    this.map.set(key, hit);
    return hit.value;
  }

  set(key: K, value: V): void {
    const size = this.sizeOf(value);
    this.delete(key);
    // An item bigger than the whole budget is simply not cached.
    if (size > this.maxSize) return;
    this.map.set(key, { value, size });
    this.total += size;
    while (this.map.size > this.maxEntries || this.total > this.maxSize) {
      const oldest = this.map.keys().next().value as K;
      this.delete(oldest);
    }
  }

  delete(key: K): void {
    const hit = this.map.get(key);
    if (!hit) return;
    this.total -= hit.size;
    this.map.delete(key);
  }

  get size(): number {
    return this.map.size;
  }

  get totalSize(): number {
    return this.total;
  }
}

/** LRU with a time-to-live per entry, for API responses. */
export class TtlCache<K, V> {
  private lru: LruCache<K, { value: V; expires: number }>;

  constructor(
    maxEntries: number,
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
  ) {
    this.lru = new LruCache(maxEntries);
  }

  get(key: K): V | undefined {
    if (this.ttlMs <= 0) return undefined;
    const hit = this.lru.get(key);
    if (!hit) return undefined;
    if (hit.expires < this.now()) {
      this.lru.delete(key);
      return undefined;
    }
    return hit.value;
  }

  set(key: K, value: V): void {
    if (this.ttlMs <= 0) return;
    this.lru.set(key, { value, expires: this.now() + this.ttlMs });
  }
}
