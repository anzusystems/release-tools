// @ts-check
import { gunzipSync } from 'node:zlib'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'

/**
 * @typedef {object} TarEntry
 * @property {string} path path inside the package, without the leading `package/`
 * @property {Buffer} data
 * @property {string} sha256
 */

/**
 * @param {Buffer} block
 * @param {number} offset
 * @param {number} length
 */
function str(block, offset, length) {
  const s = block.subarray(offset, offset + length)
  const nul = s.indexOf(0)
  return s.subarray(0, nul < 0 ? s.length : nul).toString('utf8')
}

/**
 * @param {Buffer} block
 * @param {number} offset
 * @param {number} length
 */
function octal(block, offset, length) {
  const s = block.subarray(offset, offset + length)
  if (s[0] & 0x80) {
    // base-256
    let n = 0
    for (let i = 1; i < s.length; i++) n = n * 256 + s[i]
    return n
  }
  const text = str(block, offset, length).trim()
  return text ? parseInt(text, 8) : 0
}

/**
 * @param {Buffer} data
 * @returns {Record<string, string>}
 */
function parsePax(data) {
  /** @type {Record<string, string>} */
  const out = {}
  let i = 0
  while (i < data.length) {
    const space = data.indexOf(0x20, i)
    if (space < 0) break
    const len = parseInt(data.subarray(i, space).toString('utf8'), 10)
    if (!len) break
    const record = data.subarray(space + 1, i + len - 1).toString('utf8')
    const eq = record.indexOf('=')
    if (eq > 0) out[record.slice(0, eq)] = record.slice(eq + 1)
    i += len
  }
  return out
}

/**
 * Reads the regular files of a gzipped tarball as npm, pnpm and yarn pack it (`package/` prefix).
 * @param {Buffer} tgz
 * @returns {TarEntry[]}
 */
export function readTgz(tgz) {
  const tar = gunzipSync(tgz)
  /** @type {TarEntry[]} */
  const entries = []
  let offset = 0
  /** @type {Record<string, string>} */
  let pax = {}
  let longName = null
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512)
    if (header.every((b) => b === 0)) break
    const size = octal(header, 124, 12)
    const type = String.fromCharCode(header[156] || 48)
    const prefix = str(header, 345, 155)
    let name = str(header, 0, 100)
    if (prefix) name = `${prefix}/${name}`
    const dataStart = offset + 512
    const data = tar.subarray(dataStart, dataStart + size)
    offset = dataStart + Math.ceil(size / 512) * 512
    if (type === 'x') {
      pax = parsePax(data)
      continue
    }
    if (type === 'g') continue
    if (type === 'L') {
      longName = str(data, 0, data.length)
      continue
    }
    if (pax.path) name = pax.path
    if (longName) name = longName
    pax = {}
    longName = null
    if (type !== '0' && type !== '\0' && type !== '7') continue
    const path = name.replace(/^[^/]+\//, '')
    const copy = Buffer.from(data)
    entries.push({ path, data: copy, sha256: createHash('sha256').update(copy).digest('hex') })
  }
  return entries
}

/** @param {string} file */
export async function readTgzFile(file) {
  return readTgz(await readFile(file))
}

/**
 * npm's integrity string of a tarball.
 * @param {Buffer} data
 */
export function integrity(data) {
  return `sha512-${createHash('sha512').update(data).digest('base64')}`
}

/** @param {Buffer} data */
export function sha512Hex(data) {
  return createHash('sha512').update(data).digest('hex')
}
