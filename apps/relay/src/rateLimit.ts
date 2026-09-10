// Token-bucket limiter — the only thing between one looping self-hosted server and the
// whole APNs quota. Keyed per device token AND source IP: bound one device, one bad actor.
export interface BucketConfig {
  capacity: number;
  refillPerSecond: number;
}

interface Bucket {
  tokens: number;
  updatedAt: number;
}

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(
    private readonly config: BucketConfig,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Returns true when the caller may proceed and consumes one token. */
  take(key: string): boolean {
    const now = this.now();
    const bucket = this.buckets.get(key) ?? { tokens: this.config.capacity, updatedAt: now };
    const elapsedSeconds = (now - bucket.updatedAt) / 1000;
    bucket.tokens = Math.min(
      this.config.capacity,
      bucket.tokens + elapsedSeconds * this.config.refillPerSecond,
    );
    bucket.updatedAt = now;
    if (bucket.tokens < 1) {
      this.buckets.set(key, bucket);
      return false;
    }
    bucket.tokens -= 1;
    this.buckets.set(key, bucket);
    return true;
  }

  /** Drops buckets that have fully refilled, so the map cannot grow forever. */
  sweep(): void {
    const now = this.now();
    const fullAfterMs = (this.config.capacity / this.config.refillPerSecond) * 1000;
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.updatedAt > fullAfterMs) this.buckets.delete(key);
    }
  }

  get size(): number {
    return this.buckets.size;
  }
}
