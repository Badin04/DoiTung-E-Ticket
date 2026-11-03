'use strict';
// Minimal self-contained QR Code Version 3-L encoder, binary/byte mode.
// Designed for short opaque check-in tokens up to 53 UTF-8 bytes.
// Implements the ISO/IEC 18004 function patterns, Reed–Solomon ECC and mask 0.
const SIZE = 29;
const CAPACITY = 55; // 55 data + 15 error-correction codewords = Version 3-L
const ECC = 15;

function gfMul(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11D);
    z ^= ((y >>> i) & 1) * x;
  }
  return z;
}
function rsDivisor(degree) {
  const result = Array(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      result[j] = gfMul(result[j], root);
      if (j + 1 < degree) result[j] ^= result[j + 1];
    }
    root = gfMul(root, 0x02);
  }
  return result;
}
function rsRemainder(bytes, divisor) {
  const rem = Array(divisor.length).fill(0);
  for (const byte of bytes) {
    const factor = byte ^ rem.shift();
    rem.push(0);
    for (let i = 0; i < rem.length; i++) rem[i] ^= gfMul(divisor[i], factor);
  }
  return rem;
}
function encodeBytes(payload) {
  const bytes = Buffer.from(payload, 'utf8');
  if (bytes.length > 53) throw new Error('QR token too long for Version 3-L');
  const bits = [];
  const append = (value, len) => { for (let i = len - 1; i >= 0; i--) bits.push((value >>> i) & 1); };
  append(0b0100, 4); // byte mode
  append(bytes.length, 8);
  for (const b of bytes) append(b, 8);
  for (let i = 0, n = Math.min(4, CAPACITY * 8 - bits.length); i < n; i++) bits.push(0);
  while (bits.length % 8 !== 0) bits.push(0);
  const data = [];
  for (let i = 0; i < bits.length; i += 8) data.push(parseInt(bits.slice(i, i + 8).join(''), 2));
  while (data.length < CAPACITY) data.push(data.length % 2 === 0 ? 0xEC : 0x11);
  return data.concat(rsRemainder(data, rsDivisor(ECC)));
}
function matrix(payload) {
  const cells = Array.from({length: SIZE}, () => Array(SIZE).fill(false));
  const fixed = Array.from({length: SIZE}, () => Array(SIZE).fill(false));
  const set = (x, y, dark) => {
    if (x >= 0 && y >= 0 && x < SIZE && y < SIZE) { cells[y][x] = Boolean(dark); fixed[y][x] = true; }
  };
  const finder = (cx, cy) => {
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      const dist = Math.max(Math.abs(dx), Math.abs(dy));
      set(cx + dx, cy + dy, dist !== 2 && dist !== 4);
    }
  };
  finder(3, 3); finder(SIZE - 4, 3); finder(3, SIZE - 4);
  for (let i = 8; i < SIZE - 8; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
  for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++)
    set(22 + dx, 22 + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  // ECC level L => format indicator 1; selected data mask = 0
  const formatData = (1 << 3) | 0;
  let rem = formatData;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  const format = ((formatData << 10) | rem) ^ 0x5412;
  const bit = (i) => ((format >>> i) & 1) !== 0;
  for (let i = 0; i <= 5; i++) set(8, i, bit(i));
  set(8, 7, bit(6)); set(8, 8, bit(7)); set(7, 8, bit(8));
  for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));
  for (let i = 0; i < 8; i++) set(SIZE - 1 - i, 8, bit(i));
  for (let i = 8; i < 15; i++) set(8, SIZE - 15 + i, bit(i));
  set(8, SIZE - 8, true); // always-dark module

  const dataBits = encodeBytes(payload).flatMap(b => Array.from({length: 8}, (_, i) => (b >>> (7 - i)) & 1));
  let index = 0;
  for (let right = SIZE - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < SIZE; vert++) {
      const y = (((right + 1) & 2) === 0) ? SIZE - 1 - vert : vert;
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        if (!fixed[y][x]) {
          const value = index < dataBits.length ? Boolean(dataBits[index]) : false;
          cells[y][x] = value !== ((x + y) % 2 === 0);
          index++;
        }
      }
    }
  }
  if (index < dataBits.length) throw new Error('QR matrix has insufficient space');
  return cells;
}
function svg(payload, pixels = 300) {
  const cells = matrix(payload);
  const margin = 4;
  const paths = [];
  for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++)
    if (cells[y][x]) paths.push(`M${x + margin},${y + margin}h1v1h-1z`);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${pixels}" height="${pixels}" viewBox="0 0 ${SIZE + margin * 2} ${SIZE + margin * 2}" shape-rendering="crispEdges" role="img" aria-label="QR ticket"><rect width="100%" height="100%" fill="#fff"/><path fill="#102e29" d="${paths.join('')}"/></svg>`;
}
module.exports = { svg, matrix };
