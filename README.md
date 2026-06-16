# Next.js Image Cache Pruner

Small Node.js script for pruning the on-disk `next/image` optimizer cache when self-hosting Next.js.

This is useful for older Next.js versions where the image optimizer cache can grow without a
configured disk-size limit, sometimes filling the filesystem during traffic spikes, go-lives,
or image parameter changes.

For newer versions of next, this can be managed through configuration, see also
https://github.com/vercel/next.js/security/advisories/GHSA-3x4c-7xq6-9pq8

## What It Does

The script enforces a maximum size for:

```txt
.next/cache/images
```

When the cache grows beyond `--max`, it removes whole cache-entry directories, oldest first, until
the cache is below `--target`.

It does not delete individual optimized image files.

## Requirements

Use a reasonably modern Node.js version that supports `fs.rm`.

## Why Not `find -ctime`?

Deleting by age alone is hard to tune:

- some projects generate cache slowly
- others can fill hundreds of GB very quickly
- a fixed number of days does not protect the filesystem

This script uses cache size as the main control instead.

## Usage

Dry run first:

```bash
node prune-cache.mjs \
  --cache-dir /path/to/app/shared/.next/cache/images \
  --max 50gb \
  --target 45gb \
  --min-age 15m \
  --dry-run
```

Run for real:

```bash
node prune-cache.mjs \
  --cache-dir /path/to/app/shared/.next/cache/images \
  --max 50gb \
  --target 45gb \
  --min-age 15m
```

## Options

| Option | Required | Example | Description |
| --- | --- | --- | --- |
| `--cache-dir` | yes | `/var/www/app/shared/.next/cache/images` | Path to the Next.js image cache directory |
| `--max` | yes | `50gb` | Start pruning when the cache exceeds this size |
| `--target` | no | `45gb` | Prune until the cache is below this size. Defaults to `--max` |
| `--min-age` | no | `15m` | Do not remove entries newer than this. Defaults to `15m` |
| `--dry-run` | no | | Show what would be removed without deleting anything |
| `--force` | no | | Allow pruning a path that does not end in `.next/cache/images` |

Supported size units:

```txt
b, kb, mb, gb, tb, kib, mib, gib, tib
```

Supported duration units:

```txt
ms, s, m, h, d
```

## Cron Example

Run every 5 minutes:

```cron
*/5 * * * * node /usr/local/bin/prune-cache.mjs --cache-dir /home/app/current/shared/.next/cache/images --max 50gb --target 45gb --min-age 15m >> /var/log/next-image-cache-prune.log 2>&1
```

## Safety Features

The script includes a few guardrails:

- refuses to prune paths that do not end with `.next/cache/images`
- deletes only immediate child directories of the cache directory
- ignores symlinks
- uses a lock directory to prevent overlapping prune runs
- supports `--dry-run`
- keeps very recent cache entries via `--min-age`

## Eviction Strategy

Entries are removed oldest first based on directory modification time.

This is not perfect LRU. Linux filesystems often do not update access time reliably, so true
"least recently used" pruning is usually not dependable from a cron script.

For this cache structure, oldest-first size-based pruning is a practical fallback until the
application can use Next.js' built-in image cache size limit.

## Newer Next.js Versions

Newer patched versions of Next.js support:

```js
// next.config.js
module.exports = {
  images: {
    maximumDiskCacheSize: 50_000_000_000,
  },
}
```

If your project can use that option, prefer the built-in cache limit over this script.
