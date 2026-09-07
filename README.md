# tiered-exp-rediscache

A two-tier cache on top of [exp-asynccache](https://www.npmjs.com/package/exp-asynccache) and [exp-rediscache](https://www.npmjs.com/package/exp-rediscache):

- **Tier 1**: in-memory LRU (`exp-asynccache`), served in microseconds
- **Tier 2**: Redis (`exp-rediscache`), shared across processes

Tier 1 is kept consistent by subscribing to Redis [keyspace notifications](https://redis.io/docs/latest/develop/use/keyspace-notifications/). When a key is deleted or expires in Redis, every process drops it from its in-memory tier. In-flight tier 2 reads are deduplicated per key.

## Requirements

- Node 22 (see `.nvmrc`)
- Redis with keyspace notifications enabled:

```console
redis-server --notify-keyspace-events Exg
```

or at runtime:

```console
redis-cli CONFIG SET notify-keyspace-events Exg
```

`E` = key-event channel, `x` = expired, `g` = generic commands (`DEL`, `EXPIRE`, ...). Add `$` if you also want writes made directly in Redis by other clients to invalidate tier 1.

`docker-compose.yml` starts a Redis 7.2 with this config:

```console
docker compose up -d
```

## Install

```console
npm install tiered-exp-rediscache exp-asynccache exp-rediscache ioredis
```

## Usage

```js
import Redis from "ioredis";
import AsyncCache from "exp-asynccache";
import RedisCache from "exp-rediscache";
import { TieredCache } from "tiered-exp-rediscache";

const redis = new Redis();

const cache = new TieredCache(
  redis,
  new AsyncCache(),                 // tier 1: in-memory LRU
  new AsyncCache(new RedisCache(redis)), // tier 2: Redis
  { db: 0, tier1Ttl: 5_000 }        // listen on DB 0, tier 1 entries live at most 5 s
);

await cache.set("user:1", { name: "Ada" }, 60_000); // ttl in ms, applied to both tiers
await cache.get("user:1");   // tier 1 hit
await cache.has("user:1");   // true
await cache.del("user:1");   // removes from both tiers

cache.on("invalidated", ({ key }) => console.log("dropped", key));
cache.on("error", console.error);

await cache.close(); // quits the subscriber connection
```

### Constructor

`new TieredCache(redisClient, tier1, tier2, options)`

| arg | description |
| --- | --- |
| `redisClient` | ioredis client, used for tier 2 |
| `tier1` | any `AsyncCache`-compatible cache, kept in memory |
| `tier2` | any `AsyncCache`-compatible cache, typically `new AsyncCache(new RedisCache(redis))` |
| `options.db` | Redis DB index to subscribe to (default `0`) |
| `options.redis` | ioredis options for the dedicated subscriber connection |
| `options.tier1Ttl` | max ms an entry lives in tier 1, whatever happens in Redis. Safety net for missed notifications. Optional |

### Methods

All return promises.

- `get(key)` tier 1, then tier 2. A tier 2 hit is written back to tier 1. Concurrent misses on the same key share one tier 2 read.
- `set(key, value, ttl)` writes tier 2 then tier 1. Tier 1 gets the shorter of `ttl` and `tier1Ttl`.
- `has(key)` true if either tier has the key.
- `del(key)` removes from both tiers.
- `reset()` clears both tiers.
- `close()` quits the subscriber connection.

### Events

`TieredCache` is an `EventEmitter`.

- `set` `{ key, value, ttl }`
- `invalidated` `{ key, channel? }` on local `del()` or on a Redis `DEL`/expire notification
- `reset`
- `error` tier 2 read failures and tier 1 eviction failures. Attach a listener or Node will throw.

## Caveats

- Keyspace notifications are fire-and-forget pub/sub. A process that is disconnected when the event fires keeps the stale tier 1 entry. Set `tier1Ttl` to bound how long. Without it, entries populated by `get()` live until tier 1's LRU evicts them or a notification arrives.
- Redis expiry notifications fire when Redis notices the key is gone, which can lag the actual TTL.
- `options.redis` must point at the same Redis instance as `redisClient`, otherwise notifications will never arrive.

## Development

```console
docker compose up -d
npm test
```

Tests configure `notify-keyspace-events Exg` on the running Redis themselves.

## Benchmark

Read-heavy workload (99.5% GET, 0.4% SET, 0.1% DEL) over 50 keys with 50 concurrent workers for 5 seconds each:

```console
docker compose up -d
node benchmark.js
```

```console
=== Benchmark: RedisCache only ===
Ops: 204403, Avg Latency: 1.223 ms
P50: 1.150 ms, P95: 1.801 ms, P99: 2.670 ms

=== Benchmark: TieredCache (in-mem + Redis) ===
Ops: 1316833, Avg Latency: 0.190 ms
P50: 0.013 ms, P95: 1.004 ms, P99: 1.260 ms
```

The workload is deliberately skewed towards reads with few writes, which is where a memory tier pays off. Write-heavy workloads gain little.
