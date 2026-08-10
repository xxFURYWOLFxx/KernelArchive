// Minimal streaming ZIP writer (stored, no compression).
// PE binaries are the payload here and the archive is produced on demand, so the
// CPU cost of deflate buys little; storing lets each entry stream straight from
// disk with bounded memory. Emits local headers, then the central directory.
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";

const crc_table = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32_update(crc: number, chunk: Buffer) {
  let value = crc;
  for (let index = 0; index < chunk.length; index += 1) {
    value = (crc_table[(value ^ (chunk[index] as number)) & 0xff] as number) ^ (value >>> 8);
  }
  return value >>> 0;
}

function dos_datetime(date: Date) {
  const year = Math.max(1980, date.getFullYear());
  const time = ((date.getHours() & 0x1f) << 11) | ((date.getMinutes() & 0x3f) << 5) | ((Math.floor(date.getSeconds() / 2)) & 0x1f);
  const day = (((year - 1980) & 0x7f) << 9) | (((date.getMonth() + 1) & 0x0f) << 5) | (date.getDate() & 0x1f);
  return { time, day };
}

export interface ZipEntry {
  path: string;
  source: string;
}

interface CentralRecord {
  name: Buffer;
  crc: number;
  size: number;
  offset: number;
  time: number;
  day: number;
}

export async function* zip_entries(entries: ZipEntry[]): AsyncGenerator<Buffer> {
  const central: CentralRecord[] = [];
  let offset = 0;

  for (const entry of entries) {
    let size = 0;
    let modified = new Date();
    try {
      const info = await stat(entry.source);
      if (!info.isFile()) { continue; }
      size = info.size;
      modified = info.mtime;
    } catch {
      continue;
    }

    const name = Buffer.from(entry.path.replace(/\\/g, "/"), "utf8");
    const { time, day } = dos_datetime(modified);

    // Streaming means the CRC is unknown when the local header is written, so
    // flag bit 3 is set and the real values follow the data as a descriptor.
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0008, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(day, 12);
    local.writeUInt32LE(0, 14);
    local.writeUInt32LE(0, 18);
    local.writeUInt32LE(0, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    name.copy(local, 30);
    yield local;

    const entry_offset = offset;
    offset += local.length;

    let crc = 0xffffffff;
    let written = 0;
    for await (const chunk of createReadStream(entry.source)) {
      const buffer = chunk as Buffer;
      crc = crc32_update(crc, buffer);
      written += buffer.length;
      offset += buffer.length;
      yield buffer;
    }
    crc = (crc ^ 0xffffffff) >>> 0;

    const descriptor = Buffer.alloc(16);
    descriptor.writeUInt32LE(0x08074b50, 0);
    descriptor.writeUInt32LE(crc, 4);
    descriptor.writeUInt32LE(written, 8);
    descriptor.writeUInt32LE(written, 12);
    yield descriptor;
    offset += descriptor.length;

    central.push({ name, crc, size: written || size, offset: entry_offset, time, day });
  }

  const directory_offset = offset;
  let directory_size = 0;
  for (const record of central) {
    const header = Buffer.alloc(46 + record.name.length);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(0x0008, 8);
    header.writeUInt16LE(0, 10);
    header.writeUInt16LE(record.time, 12);
    header.writeUInt16LE(record.day, 14);
    header.writeUInt32LE(record.crc, 16);
    header.writeUInt32LE(record.size, 20);
    header.writeUInt32LE(record.size, 24);
    header.writeUInt16LE(record.name.length, 28);
    header.writeUInt16LE(0, 30);
    header.writeUInt16LE(0, 32);
    header.writeUInt16LE(0, 34);
    header.writeUInt16LE(0, 36);
    header.writeUInt32LE(0, 38);
    header.writeUInt32LE(record.offset, 42);
    record.name.copy(header, 46);
    yield header;
    directory_size += header.length;
  }

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(central.length, 8);
  end.writeUInt16LE(central.length, 10);
  end.writeUInt32LE(directory_size, 12);
  end.writeUInt32LE(directory_offset, 16);
  end.writeUInt16LE(0, 20);
  yield end;
}
