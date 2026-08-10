// Instruction-aware wildcarding for x86-64 signature bytes.
// Relative call/jump displacements and RIP-relative displacements encode
// link-time addresses, so they differ between builds of the same function and
// must be wildcarded for a pattern to survive a rebuild. Decoding stops at the
// first opcode this table does not cover, leaving the remaining bytes fixed.

const modrm_one_byte = new Set<number>([
  0x00, 0x01, 0x02, 0x03, 0x08, 0x09, 0x0a, 0x0b,
  0x10, 0x11, 0x12, 0x13, 0x18, 0x19, 0x1a, 0x1b,
  0x20, 0x21, 0x22, 0x23, 0x28, 0x29, 0x2a, 0x2b,
  0x30, 0x31, 0x32, 0x33, 0x38, 0x39, 0x3a, 0x3b,
  0x62, 0x63, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89,
  0x8a, 0x8b, 0x8c, 0x8d, 0x8e, 0x8f,
  0xd0, 0xd1, 0xd2, 0xd3, 0xfe, 0xff,
]);

const immediate_after_modrm_one_byte = new Map<number, number>([
  [0x69, 4], [0x6b, 1], [0x80, 1], [0x81, 4], [0x83, 1],
  [0xc0, 1], [0xc1, 1], [0xc6, 1], [0xc7, 4],
]);

const no_modrm_immediate_one_byte = new Map<number, number>([
  [0x04, 1], [0x0c, 1], [0x14, 1], [0x1c, 1], [0x24, 1], [0x2c, 1], [0x34, 1], [0x3c, 1],
  [0x05, 4], [0x0d, 4], [0x15, 4], [0x1d, 4], [0x25, 4], [0x2d, 4], [0x35, 4], [0x3d, 4],
  [0x68, 4], [0x6a, 1], [0xa8, 1], [0xa9, 4], [0xc2, 2], [0xcd, 1],
]);

const no_operand_one_byte = new Set<number>([
  0x50, 0x51, 0x52, 0x53, 0x54, 0x55, 0x56, 0x57,
  0x58, 0x59, 0x5a, 0x5b, 0x5c, 0x5d, 0x5e, 0x5f,
  0x90, 0x98, 0x99, 0x9c, 0x9d, 0xc3, 0xc9, 0xcc,
  0xf4, 0xf5, 0xf8, 0xf9, 0xfa, 0xfb, 0xfc, 0xfd,
]);

const modrm_two_byte = new Set<number>([
  0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17,
  0x28, 0x29, 0x2a, 0x2b, 0x2c, 0x2d, 0x2e, 0x2f,
  0x40, 0x41, 0x42, 0x43, 0x44, 0x45, 0x46, 0x47,
  0x48, 0x49, 0x4a, 0x4b, 0x4c, 0x4d, 0x4e, 0x4f,
  0x51, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5c, 0x5e, 0x5f,
  0x6e, 0x6f, 0x7e, 0x7f,
  0x90, 0x91, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97,
  0x98, 0x99, 0x9a, 0x9b, 0x9c, 0x9d, 0x9e, 0x9f,
  0xa3, 0xab, 0xaf, 0xb0, 0xb1, 0xb6, 0xb7, 0xbc, 0xbd, 0xbe, 0xbf,
  0xc0, 0xc1, 0xd6, 0xef,
]);

interface DecodedInstruction {
  length: number;
  wildcard_offsets: number[];
}

function decode_instruction(bytes: Buffer, start: number): DecodedInstruction | undefined {
  let index = start;
  let operand_16 = false;

  while (index < bytes.length) {
    const prefix = bytes[index] as number;
    if (prefix === 0x66) { operand_16 = true; index += 1; continue; }
    if (prefix === 0x67 || prefix === 0xf0 || prefix === 0xf2 || prefix === 0xf3
      || prefix === 0x2e || prefix === 0x36 || prefix === 0x3e || prefix === 0x26
      || prefix === 0x64 || prefix === 0x65) { index += 1; continue; }
    break;
  }

  let rex = 0;
  if (index < bytes.length && (bytes[index] as number) >= 0x40 && (bytes[index] as number) <= 0x4f) {
    rex = bytes[index] as number;
    index += 1;
  }

  if (index >= bytes.length) { return undefined; }
  const opcode = bytes[index] as number;
  index += 1;

  const wildcard_offsets: number[] = [];

  const read_modrm = (immediate_size: number): DecodedInstruction | undefined => {
    if (index >= bytes.length) { return undefined; }
    const modrm = bytes[index] as number;
    index += 1;
    const mod = modrm >> 6;
    const rm = modrm & 0x07;
    if (mod !== 3 && rm === 4) {
      if (index >= bytes.length) { return undefined; }
      index += 1;
    }
    if (mod === 0 && rm === 5) {
      if (index + 4 > bytes.length) { return undefined; }
      for (let offset = 0; offset < 4; offset += 1) { wildcard_offsets.push(index + offset); }
      index += 4;
    } else if (mod === 1) {
      if (index + 1 > bytes.length) { return undefined; }
      index += 1;
    } else if (mod === 2) {
      if (index + 4 > bytes.length) { return undefined; }
      index += 4;
    }
    if (immediate_size > 0) {
      if (index + immediate_size > bytes.length) { return undefined; }
      index += immediate_size;
    }
    return { length: index - start, wildcard_offsets };
  };

  if (opcode === 0x0f) {
    if (index >= bytes.length) { return undefined; }
    const second = bytes[index] as number;
    index += 1;
    if (second >= 0x80 && second <= 0x8f) {
      if (index + 4 > bytes.length) { return undefined; }
      for (let offset = 0; offset < 4; offset += 1) { wildcard_offsets.push(index + offset); }
      index += 4;
      return { length: index - start, wildcard_offsets };
    }
    if (second === 0xba) { return read_modrm(1); }
    if (second === 0x70 || second === 0x71 || second === 0x72 || second === 0x73
      || second === 0xc2 || second === 0xc4 || second === 0xc5 || second === 0xc6) { return read_modrm(1); }
    if (second === 0x05 || second === 0x0b || second === 0x06 || second === 0x09
      || second === 0x30 || second === 0x31 || second === 0x32 || second === 0x33 || second === 0xa2) {
      return { length: index - start, wildcard_offsets };
    }
    if (modrm_two_byte.has(second)) { return read_modrm(0); }
    return undefined;
  }

  if (opcode === 0xe8 || opcode === 0xe9) {
    if (index + 4 > bytes.length) { return undefined; }
    for (let offset = 0; offset < 4; offset += 1) { wildcard_offsets.push(index + offset); }
    index += 4;
    return { length: index - start, wildcard_offsets };
  }

  if (opcode === 0xeb || (opcode >= 0x70 && opcode <= 0x7f)) {
    if (index + 1 > bytes.length) { return undefined; }
    index += 1;
    return { length: index - start, wildcard_offsets };
  }

  if (opcode >= 0xb8 && opcode <= 0xbf) {
    const size = (rex & 0x08) !== 0 ? 8 : operand_16 ? 2 : 4;
    if (index + size > bytes.length) { return undefined; }
    index += size;
    return { length: index - start, wildcard_offsets };
  }

  if (opcode >= 0xb0 && opcode <= 0xb7) {
    if (index + 1 > bytes.length) { return undefined; }
    index += 1;
    return { length: index - start, wildcard_offsets };
  }

  if (opcode === 0xf6 || opcode === 0xf7) {
    if (index >= bytes.length) { return undefined; }
    const reg = ((bytes[index] as number) >> 3) & 0x07;
    const immediate = reg === 0 || reg === 1 ? (opcode === 0xf6 ? 1 : operand_16 ? 2 : 4) : 0;
    return read_modrm(immediate);
  }

  if (no_operand_one_byte.has(opcode)) { return { length: index - start, wildcard_offsets }; }

  const plain_immediate = no_modrm_immediate_one_byte.get(opcode);
  if (plain_immediate !== undefined) {
    const size = plain_immediate === 4 && operand_16 ? 2 : plain_immediate;
    if (index + size > bytes.length) { return undefined; }
    index += size;
    return { length: index - start, wildcard_offsets };
  }

  const modrm_immediate = immediate_after_modrm_one_byte.get(opcode);
  if (modrm_immediate !== undefined) {
    const size = modrm_immediate === 4 && operand_16 ? 2 : modrm_immediate;
    return read_modrm(size);
  }

  if (modrm_one_byte.has(opcode)) { return read_modrm(0); }

  return undefined;
}

// Returns a mask string ('x' fixed, '?' wildcard) for the supplied code bytes.
// Bytes after an undecodable instruction stay fixed.
export function volatile_operand_mask(bytes: Buffer): string {
  const mask = new Array<string>(bytes.length).fill("x");
  let offset = 0;
  while (offset < bytes.length) {
    const decoded = decode_instruction(bytes, offset);
    if (!decoded || decoded.length <= 0) { break; }
    if (offset + decoded.length > bytes.length) { break; }
    for (const wildcard of decoded.wildcard_offsets) {
      if (wildcard < mask.length) { mask[wildcard] = "?"; }
    }
    offset += decoded.length;
  }
  return mask.join("");
}
