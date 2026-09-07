import { EventEmitter } from "events";
import Redis from "ioredis";

/**
 * TieredCache
 *
 * Implements a two-tier cache:
 *  - Tier1: in-memory AsyncCache (user-supplied)
 *  - Tier2: persistent AsyncCache (typically RedisCache, user-supplied)
 *
 * Keyspace notifications from Redis are used to invalidate the tier1 cache automatically.
 */
// eslint-disable-next-line @bonniernews/typescript-rules/disallow-class-extends
export class TieredCache extends EventEmitter {
  /**
   * @param {Redis} redisClient - ioredis client for tier2 commands
   * @param {AsyncCache} tier1 - first-tier in-memory cache
   * @param {AsyncCache} tier2 - second-tier persistent cache
   * @param {Object} options
   *        options.db - Redis DB index for notifications (default 0)
   *        options.redis - ioredis options for the subscriber (optional)
   *        options.tier1Ttl - max ms an entry may live in tier1 regardless of notifications (optional)
   */
  constructor(redisClient, tier1, tier2, options = {}) {
    super();

    if (!redisClient || !tier1 || !tier2) {
      throw new Error("Redis client, tier1, and tier2 caches must all be provided.");
    }

    this.redisClient = redisClient;
    this.tier1 = tier1;
    this.tier2 = tier2;
    this.tier1Ttl = options.tier1Ttl;
    // Promise cache for preventing duplicate fetches
    this.inflightPromises = new Map();

    const dbIndex = options.db || 0;
    const channel = `__keyevent@${dbIndex}__:*`;

    // Dedicated subscriber client (required by ioredis)
    this.subscriber = new Redis(options.redis);
    this.subscriber.psubscribe(channel);
    this.subscriber.on("pmessage", (_, ch, key) => {
      this.tier1.del(key)
        .then(() => this.emit("invalidated", { key, channel: ch }))
        .catch((err) => this.emit("error", err));
    });
  }

  /** Get a key from tier1, falling back to tier2 */
  async get(key) {
    let val = await this.tier1.get(key);
    // console.log(`${key} is ${val} in tier1`);
    if (val !== undefined) {
      return val;
    }
    // Check if we're already fetching this key
    if (this.inflightPromises.has(key)) {
      return this.inflightPromises.get(key);
    }

    const fetchPromise = this.tier2.get(key);
    this.inflightPromises.set(key, fetchPromise);

    try {
      val = await fetchPromise;
      if (val !== undefined) {
        await this.tier1.set(key, val, this.tier1Ttl);
      }
      // console.log(`${key} is ${val} in tier2`);
      return val;
    } catch (err) {
      this.emit("error", err);
    } finally {
      // Always clean up the inflight promise
      this.inflightPromises.delete(key);
    }
  }

  /** Set a key in both tiers */
  async set(key, value, ttl) {
    await this.tier2.set(key, value, ttl);
    await this.tier1.set(key, value, minTtl(ttl, this.tier1Ttl));
    this.inflightPromises.delete(key);
    this.emit("set", { key, value, ttl });
  }

  /** Check if a key exists in either tier */
  async has(key) {
    if (await this.tier1.has(key)) return true;
    return this.tier2.has(key);
  }

  /** Delete a key from both tiers and emit invalidation */
  async del(key) {
    await this.tier2.del(key);
    await this.tier1.del(key);
    this.inflightPromises.delete(key);
    this.emit("invalidated", { key });
  }

  /** Reset both tiers */
  async reset() {
    await this.tier2.reset();
    await this.tier1.reset();
    this.inflightPromises.clear();
    this.emit("reset");
  }

  /** Close the subscriber connection */
  async close() {
    if (this.subscriber) await this.subscriber.quit();
  }
}

/** Shortest of the given ttls, ignoring undefined. Undefined if none given. */
function minTtl(...ttls) {
  const nums = ttls.filter((t) => typeof t === "number");
  return nums.length ? Math.min(...nums) : undefined;
}
