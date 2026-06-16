#!/usr/bin/env node
import { promises as fs } from 'node:fs'
import path from 'node:path'

const startedAt = Date.now()

log('Started.')
try {
  await main()
  log(`Finished in ${formatDuration(Date.now() - startedAt)}.`)
} catch (error) {
  log(`Failed after ${formatDuration(Date.now() - startedAt)}.`)
  console.error(error.stack ?? error)
  process.exitCode = 1
}

async function main() {
  const args = parseArgs(process.argv.slice(2))

  const cacheDir = path.resolve(required(args, 'cache-dir'))
  const maxBytes = parseBytes(required(args, 'max'))
  const targetBytes = parseBytes(args.target ?? args.max)
  const minAgeMs = parseDuration(args['min-age'] ?? '15m')
  const dryRun = Boolean(args['dry-run'])
  const force = Boolean(args.force)

  if (targetBytes > maxBytes) {
    throw new Error('--target must be <= --max')
  }

  await assertSafeCacheDir(cacheDir, force)

  const lockDir = path.join(cacheDir, '.prune-lock')
  const releaseLock = await acquireLock(lockDir)

  try {
    const entries = await getCacheEntries(cacheDir)
    const now = Date.now()
    const totalBytes = entries.reduce((sum, entry) => sum + entry.bytes, 0)
    const eligibleEntries = entries.filter((entry) => now - entry.mtimeMs >= minAgeMs)

    log(`Cache: ${cacheDir}`)
    log(`Current size: ${formatBytes(totalBytes)}`)
    log(`Max size: ${formatBytes(maxBytes)}`)
    log(`Target size: ${formatBytes(targetBytes)}`)
    log(`Total entries: ${entries.length}`)
    log(`Eligible entries: ${eligibleEntries.length}`)

    if (totalBytes <= maxBytes) {
      log('Nothing to prune.')
    } else {
      let currentBytes = totalBytes
      let removedBytes = 0
      let removedCount = 0

      eligibleEntries.sort((a, b) => a.mtimeMs - b.mtimeMs)

      for (const entry of eligibleEntries) {
        if (currentBytes <= targetBytes) break

        if (!dryRun) {
          await fs.rm(entry.path, { recursive: true, force: true })
        }

        currentBytes -= entry.bytes
        removedBytes += entry.bytes
        removedCount += 1
      }

      log(`${dryRun ? 'Would remove' : 'Removed'} ${formatCount(removedCount, 'entry', 'entries')}, ${formatBytes(removedBytes)}.`)
      log(`Estimated final size: ${formatBytes(currentBytes)}`)

      if (currentBytes > targetBytes) {
        log(`Target not reached because there were no more eligible entries older than ${formatDuration(minAgeMs)}.`)
      }
    }
  } finally {
    await releaseLock()
  }
}

async function getCacheEntries(dir) {
  const names = await fs.readdir(dir)
  const entries = []

  for (const name of names) {
    if (name === '.prune-lock') continue

    const fullPath = path.join(dir, name)
    const stat = await fs.lstat(fullPath)

    if (!stat.isDirectory()) continue
    if (stat.isSymbolicLink()) continue

    entries.push({
      path: fullPath,
      mtimeMs: stat.mtimeMs,
      bytes: await directorySize(fullPath),
    })
  }

  return entries
}

async function directorySize(dir) {
  let total = 0
  const items = await fs.readdir(dir, { withFileTypes: true })

  for (const item of items) {
    const fullPath = path.join(dir, item.name)
    const stat = await fs.lstat(fullPath)

    if (stat.isSymbolicLink()) continue

    total += stat.size

    if (stat.isDirectory()) {
      total += await directorySize(fullPath)
    }
  }

  return total
}

async function assertSafeCacheDir(dir, force) {
  const stat = await fs.lstat(dir)

  if (!stat.isDirectory()) {
    throw new Error(`Not a directory: ${dir}`)
  }

  const normalized = dir.split(path.sep).join('/')

  if (!force && !normalized.endsWith('/.next/cache/images')) {
    throw new Error(
      `Refusing to prune path that does not end with /.next/cache/images: ${dir}\n` +
      `Pass --force to override.`
    )
  }
}

async function acquireLock(lockDir) {
  try {
    await fs.mkdir(lockDir)
  } catch (error) {
    if (error.code === 'EEXIST') {
      throw new Error(`Another prune appears to be running: ${lockDir}`)
    }
    throw error
  }

  await fs.writeFile(path.join(lockDir, 'pid'), String(process.pid))

  return async () => {
    await fs.rm(lockDir, { recursive: true, force: true })
  }
}

function parseArgs(argv) {
  const parsed = {}

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]

    if (!arg.startsWith('--')) continue

    const key = arg.slice(2)

    if (key === 'dry-run' || key === 'force') {
      parsed[key] = true
    } else {
      parsed[key] = argv[++i]
    }
  }

  return parsed
}

function required(args, key) {
  if (!args[key]) {
    throw new Error(`Missing required argument --${key}`)
  }

  return args[key]
}

function parseBytes(value) {
  const match = String(value).trim().match(/^(\d+(?:\.\d+)?)(b|kb|mb|gb|tb|kib|mib|gib|tib)?$/i)

  if (!match) {
    throw new Error(`Invalid byte value: ${value}`)
  }

  const number = Number(match[1])
  const unit = (match[2] ?? 'b').toLowerCase()

  const multipliers = {
    b: 1,
    kb: 1000,
    mb: 1000 ** 2,
    gb: 1000 ** 3,
    tb: 1000 ** 4,
    kib: 1024,
    mib: 1024 ** 2,
    gib: 1024 ** 3,
    tib: 1024 ** 4,
  }

  return Math.floor(number * multipliers[unit])
}

function parseDuration(value) {
  const match = String(value).trim().match(/^(\d+(?:\.\d+)?)(ms|s|m|h|d)?$/i)

  if (!match) {
    throw new Error(`Invalid duration: ${value}`)
  }

  const number = Number(match[1])
  const unit = (match[2] ?? 'ms').toLowerCase()

  const multipliers = {
    ms: 1,
    s: 1000,
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
  }

  return Math.floor(number * multipliers[unit])
}

function formatBytes(bytes) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 0

  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000
    unit += 1
  }

  return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`
}

function formatDuration(ms) {
  if (ms < 1000) return `${ms}ms`

  const seconds = ms / 1000
  if (seconds < 60) return `${seconds.toFixed(seconds >= 10 ? 0 : 1)}s`

  const minutes = Math.floor(seconds / 60)
  const remainingSeconds = Math.round(seconds % 60)
  return `${minutes}m ${remainingSeconds}s`
}

function formatCount(count, singular, plural) {
  return `${count} ${count === 1 ? singular : plural}`
}

function log(message) {
  console.log(`${new Date().toISOString()} [next-image-cache-prune] ${message}`)
}
