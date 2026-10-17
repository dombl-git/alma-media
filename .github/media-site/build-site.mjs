/**
 * Builds the clips' site for `alma-media` (BRIEF-2 §9.1, §9.2). Its Action runs this on every push,
 * and this computer runs it for the tests' stand-in site (`npm run media-site:fixtures`). Plain
 * Node with no packages; ffprobe reads the clips and ffmpeg makes the pictures.
 *
 *   node build-site.mjs <repository folder> <site folder>
 *        [--previous <url or folder>] [--replace] [--ffmpeg <path>] [--ffprobe <path>]
 *
 * For every .mp4 at the top of the repository (other files and folders are left out):
 * - refuses a file over 100 MB (GitHub refuses larger ones anyway);
 * - checks it's H.264 with 8-bit 4:2:0 colour, which every browser plays;
 * - records its length, frame rate, picture size, size in bytes and fingerprint (SHA-1 of its
 *   first 1 MiB, as the app's src/io/fingerprint.ts), all of the file as pushed, so a project
 *   relinks to a clone of alma-media;
 * - publishes it ready to stream: as it is when its index (the `moov` box) comes before its
 *   pictures (`mdat`), "fast start"; otherwise as a lossless re-mux with the index moved forward;
 * - makes a thumbnail (320 px wide, a tenth of the way in) and a strip for the timeline's V1
 *   thumbnails (one frame a second, 96 px tall, 10 to a row), reusing those of the site as last
 *   published (`--previous`) when the clip's name, size and fingerprint haven't changed;
 * - writes manifest.json.
 *
 * It fails, naming each clip it can't use, or when the site would pass 900 MB (Pages takes 1 GB):
 * then the Action publishes nothing and the site stays as it was. It never writes to the
 * repository. `--replace` empties a site folder this script built before.
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  appendFileSync,
  closeSync,
  copyFileSync,
  existsSync,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const MB = 1024 * 1024

export const LIMITS = {
  /** GitHub refuses larger files. */
  fileBytes: 100 * MB,
  /** The Action stops here, short of Pages' 1 GB. */
  siteBytes: 900 * MB,
  /** What GitHub Pages publishes at most: the Media panel shows the site against it. */
  pagesBytes: 1024 * MB,
}

const FINGERPRINT_BYTES = 1024 * 1024
const THUMB_WIDTH = 320
const STRIP_HEIGHT = 96
const STRIP_COLUMNS = 10
/** Frames in one strip at most: longer clips space them out. */
const STRIP_MAX = 300

export const MANIFEST = 'manifest.json'

/** Sizes as people read them: "412 MB", "1.2 MB". */
export const megabytes = (bytes) => `${(bytes / MB).toFixed(bytes < 10 * MB ? 1 : 0)} MB`

const byName = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })

/** SHA-1 of a file's first 1 MiB, "sha1:<hex>": the app's fingerprint (src/io/fingerprint.ts). */
export function fingerprintOf(path) {
  const fd = openSync(path, 'r')
  try {
    const buf = Buffer.alloc(FINGERPRINT_BYTES)
    const n = readSync(fd, buf, 0, FINGERPRINT_BYTES, 0)
    return `sha1:${createHash('sha1').update(buf.subarray(0, n)).digest('hex')}`
  } finally {
    closeSync(fd)
  }
}

/** An MP4's top-level boxes in order ("ftyp", "moov", "mdat"…), read from their headers. */
export function topBoxes(path) {
  const fd = openSync(path, 'r')
  const boxes = []
  try {
    const size = fstatSync(fd).size
    const head = Buffer.alloc(16)
    let at = 0
    while (at + 8 <= size && boxes.length < 64) {
      readSync(fd, head, 0, 16, at)
      let length = head.readUInt32BE(0)
      if (length === 1) length = Number(head.readBigUInt64BE(8))
      else if (length === 0) length = size - at
      if (length < 8) break
      boxes.push(head.toString('latin1', 4, 8))
      at += length
    }
  } finally {
    closeSync(fd)
  }
  return boxes
}

/** Fast start: the index comes before the pictures, so playing can begin before the end arrives. */
export function startsFast(boxes) {
  const moov = boxes.indexOf('moov')
  const mdat = boxes.indexOf('mdat')
  return moov >= 0 && (mdat < 0 || moov < mdat)
}

function rate(text) {
  const [n, d] = String(text ?? '')
    .split('/')
    .map(Number)
  const r = d ? n / d : n
  return Number.isFinite(r) && r > 0 ? Math.round(r * 1000) / 1000 : 0
}

/** What ffprobe says about a clip's picture, or null if it can't read one. */
export function probe(ffprobe, path) {
  const r = spawnSync(
    ffprobe,
    [
      ...['-v', 'error', '-select_streams', 'v:0', '-of', 'json'],
      '-show_entries',
      'stream=codec_name,profile,pix_fmt,width,height,r_frame_rate,avg_frame_rate,nb_frames,duration:format=duration',
      path,
    ],
    { encoding: 'utf8' },
  )
  if (r.status !== 0) return null
  let j
  try {
    j = JSON.parse(r.stdout)
  } catch {
    return null
  }
  const s = j.streams?.[0]
  if (!s) return null
  const fps = rate(s.r_frame_rate) || rate(s.avg_frame_rate)
  const duration = Number(s.duration ?? j.format?.duration) || 0
  return {
    codec: s.codec_name ?? '',
    profile: s.profile ?? '',
    pixFmt: s.pix_fmt ?? '',
    width: Number(s.width) || 0,
    height: Number(s.height) || 0,
    fps,
    duration: Math.round(duration * 1000) / 1000,
    frames: Number(s.nb_frames) || Math.round(duration * fps),
  }
}

const CODECS = {
  hevc: 'HEVC (H.265)',
  prores: 'ProRes',
  vp8: 'VP8',
  vp9: 'VP9',
  av1: 'AV1',
  mpeg4: 'MPEG-4 Part 2',
  mpeg2video: 'MPEG-2',
  mjpeg: 'Motion JPEG',
  dnxhd: 'DNxHD/DNxHR',
}

function colourOf(pixFmt) {
  if (/1[02]/.test(pixFmt)) return '10-bit colour'
  if (/422/.test(pixFmt)) return '4:2:2 colour'
  if (/444|rgb|gbr/.test(pixFmt)) return '4:4:4 colour'
  return `${pixFmt} colour`
}

/** Why a clip can't go on the site, in plain words naming it; null if it can. */
export function problemWith(name, info) {
  if (!info) return `${name} can’t be read as a video. Export it again as H.264 MP4.`
  if (info.codec !== 'h264') {
    const codec = CODECS[info.codec] ?? info.codec.toUpperCase()
    return `${name} is ${codec}, not H.264: export it again as H.264 MP4.`
  }
  if (!/^yuvj?420p$/.test(info.pixFmt)) {
    return `${name} is H.264 with ${colourOf(info.pixFmt)}, which browsers can’t play: export it again with 8-bit 4:2:0 colour (yuv420p).`
  }
  if (!(info.width > 0 && info.height > 0 && info.duration > 0 && info.fps > 0)) {
    return `${name} has no length or picture size that can be read. Export it again as H.264 MP4.`
  }
  return null
}

function tool(path, args) {
  const r = spawnSync(path, ['-hide_banner', '-loglevel', 'error', '-y', ...args], {
    encoding: 'utf8',
  })
  if (r.status !== 0) {
    throw new Error(
      `${path} ${args.join(' ')} failed: ${(r.stderr || r.error?.message || '').trim()}`,
    )
  }
}

function imageSize(ffprobe, path) {
  const r = spawnSync(
    ffprobe,
    ['-v', 'error', '-show_entries', 'stream=width,height', '-of', 'json', path],
    { encoding: 'utf8' },
  )
  const s = JSON.parse(r.stdout || '{}').streams?.[0] ?? {}
  return { width: Number(s.width) || 0, height: Number(s.height) || 0 }
}

function makeThumb(ffmpeg, clip, duration, to) {
  const at = Math.max(0, Math.min(duration * 0.1, duration - 0.05))
  tool(ffmpeg, [
    ...['-ss', at.toFixed(3), '-i', clip, '-frames:v', '1'],
    ...['-vf', `scale=${THUMB_WIDTH}:-2`, '-q:v', '4', to],
  ])
}

/** One frame every `every` seconds from the start, tiled 10 to a row: tile i is at i × every s. */
function makeStrip(ffmpeg, ffprobe, clip, duration, out, src) {
  const every = Math.max(1, Math.ceil(duration / STRIP_MAX))
  const tmp = mkdtempSync(join(tmpdir(), 'media-site-'))
  try {
    tool(ffmpeg, [
      ...['-i', clip, '-vf', `fps=1/${every},scale=-2:${STRIP_HEIGHT}`],
      ...['-q:v', '5', join(tmp, '%05d.jpg')],
    ])
    const count = readdirSync(tmp).filter((f) => f.endsWith('.jpg')).length
    if (!count) throw new Error(`No frames came out of ${clip}`)
    const columns = Math.min(STRIP_COLUMNS, count)
    const rows = Math.ceil(count / columns)
    tool(ffmpeg, [
      ...['-framerate', '1', '-i', join(tmp, '%05d.jpg')],
      ...['-vf', `tile=${columns}x${rows}`, '-frames:v', '1', '-q:v', '5', join(out, src)],
    ])
    const size = imageSize(ffprobe, join(out, src))
    return {
      src,
      every,
      count,
      columns,
      tileWidth: Math.round(size.width / columns),
      tileHeight: Math.round(size.height / rows),
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

/** The site as last published, if it can be read: its manifest, and a way to copy its files. */
async function readPrevious(where) {
  const online = /^https?:\/\//.test(where)
  const base = online ? where.replace(/\/?$/, '/') : resolve(where)
  const get = async (rel) => {
    if (typeof rel !== 'string' || rel.includes('..') || rel.startsWith('/')) return null
    try {
      if (online) {
        const r = await fetch(new URL(rel, base), { cache: 'no-store' })
        return r.ok ? Buffer.from(await r.arrayBuffer()) : null
      }
      const p = join(base, rel)
      return existsSync(p) ? readFileSync(p) : null
    } catch {
      return null
    }
  }
  const text = await get(MANIFEST)
  if (!text) return null
  let manifest
  try {
    manifest = JSON.parse(text.toString('utf8'))
  } catch {
    return null
  }
  if (manifest?.format !== 1 || !Array.isArray(manifest.clips)) return null
  return {
    manifest,
    async copy(rel, to) {
      const b = await get(rel)
      if (!b) return false
      writeFileSync(to, b)
      return true
    },
  }
}

function folderBytes(dir) {
  let total = 0
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    total += e.isDirectory() ? folderBytes(p) : statSync(p).size
  }
  return total
}

/**
 * Builds the site into `out` (a new or empty folder; with `replace`, one this script built before
 * is emptied first). Returns the manifest, the problems (each naming its clip) and what was made.
 */
export async function buildSite({
  source,
  out,
  previous = null,
  replace = false,
  ffmpeg = 'ffmpeg',
  ffprobe = 'ffprobe',
  limits = LIMITS,
  now = new Date(),
}) {
  if (existsSync(out) && readdirSync(out).length) {
    if (!(replace && existsSync(join(out, MANIFEST)))) {
      throw new Error(`${out} isn’t empty: build the site into a new folder.`)
    }
    rmSync(out, { recursive: true, force: true })
  }
  mkdirSync(join(out, 'thumbs'), { recursive: true })
  const names = readdirSync(source, { withFileTypes: true })
    .filter((d) => d.isFile() && /\.mp4$/i.test(d.name) && !d.name.startsWith('.'))
    .map((d) => d.name)
    .sort(byName)
  const prev = previous ? await readPrevious(previous) : null
  const problems = []
  const clips = []
  const stats = { made: 0, reused: 0, remuxed: 0 }

  for (const name of names) {
    const path = join(source, name)
    const bytes = statSync(path).size
    if (bytes > limits.fileBytes) {
      problems.push(
        `${name} is ${megabytes(bytes)}: GitHub takes files up to 100 MB. Export it smaller (about 3 Mbps at 1280×720).`,
      )
      continue
    }
    const info = probe(ffprobe, path)
    const problem = problemWith(name, info)
    if (problem) {
      problems.push(problem)
      continue
    }
    const fingerprint = fingerprintOf(path)
    const published = join(out, name)
    const fast = startsFast(topBoxes(path))
    if (fast) copyFileSync(path, published)
    else {
      tool(ffmpeg, ['-i', path, '-map', '0', '-c', 'copy', '-movflags', '+faststart', published])
      stats.remuxed++
      if (!startsFast(topBoxes(published))) {
        problems.push(
          `${name} couldn’t be made ready to stream. Export it again with “fast start” on.`,
        )
        continue
      }
    }
    const stem = name.replace(/\.mp4$/i, '')
    const thumb = `thumbs/${stem}.jpg`
    const stripSrc = `thumbs/${stem}.strip.jpg`
    const old = prev?.manifest.clips.find(
      (c) => c.name === name && c.bytes === bytes && c.fingerprint === fingerprint,
    )
    let strip
    if (
      old?.strip &&
      (await prev.copy(old.thumb, join(out, thumb))) &&
      (await prev.copy(old.strip.src, join(out, stripSrc)))
    ) {
      strip = { ...old.strip, src: stripSrc }
      stats.reused++
    } else {
      makeThumb(ffmpeg, path, info.duration, join(out, thumb))
      strip = makeStrip(ffmpeg, ffprobe, path, info.duration, out, stripSrc)
      stats.made++
    }
    clips.push({
      name,
      bytes,
      fingerprint,
      publishedBytes: statSync(published).size,
      remuxed: !fast,
      codec: info.codec,
      profile: info.profile,
      width: info.width,
      height: info.height,
      fps: info.fps,
      duration: info.duration,
      frames: info.frames,
      thumb,
      strip,
    })
  }

  const manifest = {
    format: 1,
    built: now.toISOString(),
    siteBytes: 0,
    limitBytes: limits.pagesBytes,
    clips,
  }
  const text = () => `${JSON.stringify(manifest, null, 2)}\n`
  // Twice: the manifest counts too, with the digits of its own total
  for (let i = 0; i < 2; i++) manifest.siteBytes = folderBytes(out) + Buffer.byteLength(text())
  if (manifest.siteBytes > limits.siteBytes) {
    problems.push(
      `The clips’ site would be ${megabytes(manifest.siteBytes)}, and GitHub Pages takes 1 GB: this Action stops at ${megabytes(limits.siteBytes)}. Remove clips no cut uses from alma-media, or export them smaller.`,
    )
  }
  writeFileSync(join(out, MANIFEST), text())
  return { manifest, problems, stats }
}

/* ------------------------------------------------------------------ run as a script */

function summary({ manifest, problems, stats }) {
  const lines = problems.length
    ? [
        '### Not published',
        '',
        ...problems.map((p) => `- ${p}`),
        '',
        ...(manifest.clips.length ? ['The other clips were fine:', ''] : []),
      ]
    : [
        `### Published ${manifest.clips.length} clip${manifest.clips.length === 1 ? '' : 's'}`,
        '',
        `The site is ${megabytes(manifest.siteBytes)} of 1 GB. Thumbnails: ${stats.made} made, ${stats.reused} kept from before.${stats.remuxed ? ` Made ready to stream: ${stats.remuxed}.` : ''}`,
        '',
      ]
  if (manifest.clips.length) {
    lines.push('| Clip | Length | Frames | Size | Picture |', '| --- | --- | --- | --- | --- |')
    for (const c of manifest.clips) {
      lines.push(
        `| ${c.name} | ${c.duration} s | ${c.frames} at ${c.fps} fps | ${megabytes(c.bytes)} | ${c.width}×${c.height}${c.remuxed ? ', made ready to stream' : ''} |`,
      )
    }
  }
  return `${lines.join('\n')}\n`
}

async function main(argv) {
  const opts = { replace: false }
  const plain = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--previous') opts.previous = argv[++i]
    else if (a === '--ffmpeg') opts.ffmpeg = argv[++i]
    else if (a === '--ffprobe') opts.ffprobe = argv[++i]
    else if (a === '--replace') opts.replace = true
    else plain.push(a)
  }
  const [source, out] = plain
  if (!source || !out) {
    console.error(
      'Usage: node build-site.mjs <repository folder> <site folder> [--previous <url or folder>] [--replace]',
    )
    return 2
  }
  const result = await buildSite({ ...opts, source: resolve(source), out: resolve(out) })
  const text = summary(result)
  console.log(text)
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, text)
  if (result.problems.length) {
    // GitHub shows these on the run's page, each naming its clip
    if (process.env.GITHUB_ACTIONS) for (const p of result.problems) console.log(`::error::${p}`)
    return 1
  }
  return 0
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2))
}
