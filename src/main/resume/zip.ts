import { inflateRawSync } from 'node:zlib'

/**
 * Just enough of the ZIP format to read the XML parts of a .docx: the central
 * directory, stored and deflated entries. No ZIP64, no encryption. Every size
 * is bounded so a crafted file cannot exhaust memory.
 */

const EOCD_SIG = 0x06054b50
const CENTRAL_SIG = 0x02014b50
const LOCAL_SIG = 0x04034b50
const MAX_ENTRY_BYTES = 32 * 1024 * 1024

export interface ZipEntry {
  name: string
  method: number
  compressedSize: number
  size: number
  localOffset: number
}

export class ZipError extends Error {}

export function listZip(buf: Buffer): ZipEntry[] {
  const eocd = findEocd(buf)
  const count = buf.readUInt16LE(eocd + 10)
  let offset = buf.readUInt32LE(eocd + 16)
  const entries: ZipEntry[] = []
  for (let i = 0; i < count; i++) {
    if (offset + 46 > buf.length || buf.readUInt32LE(offset) !== CENTRAL_SIG) {
      throw new ZipError('Corrupt ZIP central directory.')
    }
    const nameLength = buf.readUInt16LE(offset + 28)
    const extraLength = buf.readUInt16LE(offset + 30)
    const commentLength = buf.readUInt16LE(offset + 32)
    entries.push({
      method: buf.readUInt16LE(offset + 10),
      compressedSize: buf.readUInt32LE(offset + 20),
      size: buf.readUInt32LE(offset + 24),
      localOffset: buf.readUInt32LE(offset + 42),
      name: buf.toString('utf8', offset + 46, offset + 46 + nameLength)
    })
    offset += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

export function readZipEntry(buf: Buffer, entry: ZipEntry): Buffer {
  const at = entry.localOffset
  if (at + 30 > buf.length || buf.readUInt32LE(at) !== LOCAL_SIG) throw new ZipError('Corrupt ZIP entry.')
  if (entry.size > MAX_ENTRY_BYTES) throw new ZipError(`${entry.name} is too large.`)
  const start = at + 30 + buf.readUInt16LE(at + 26) + buf.readUInt16LE(at + 28)
  const data = buf.subarray(start, start + entry.compressedSize)
  if (entry.method === 0) return data
  if (entry.method === 8) return inflateRawSync(data, { maxOutputLength: MAX_ENTRY_BYTES })
  throw new ZipError(`Unsupported ZIP compression method ${entry.method}.`)
}

function findEocd(buf: Buffer): number {
  // The EOCD record is 22 bytes plus an optional comment of up to 64 KiB.
  const min = Math.max(0, buf.length - 22 - 0xffff)
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i
  }
  throw new ZipError('Not a ZIP file.')
}
