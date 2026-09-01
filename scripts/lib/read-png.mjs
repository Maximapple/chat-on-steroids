/**
 * A minimal PNG reader, so a screenshot can be checked as pixels rather than as a byte count.
 *
 * Exists because the interesting question about the macOS pointer is not whether the compositor
 * says it drew — it says that already — but whether pixels changed, and in the right place. That
 * needs the actual samples, and pulling an image library into a repository for one assertion is
 * a worse trade than forty lines of the format.
 *
 * Handles what the helper writes: 8-bit RGB or RGBA, non-interlaced, all five filter types.
 * Anything else throws rather than guessing, because a decoder that quietly mis-reads produces
 * a confident wrong answer, which is the failure mode this whole exercise is about.
 */
import { inflateSync } from 'node:zlib';
import { readFileSync } from 'node:fs';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Paeth predictor, verbatim from the specification. */
function paeth(left, up, upLeft) {
  const estimate = left + up - upLeft;
  const dLeft = Math.abs(estimate - left);
  const dUp = Math.abs(estimate - up);
  const dUpLeft = Math.abs(estimate - upLeft);
  if (dLeft <= dUp && dLeft <= dUpLeft) return left;
  return dUp <= dUpLeft ? up : upLeft;
}

/**
 * Reads a PNG into `{ width, height, channels, data }`, `data` being row-major samples.
 */
export function readPNG(file) {
  const buffer = readFileSync(file);
  if (!buffer.subarray(0, 8).equals(SIGNATURE)) throw new Error(`${file} is not a PNG`);

  let width = 0;
  let height = 0;
  let channels = 0;
  const parts = [];
  let offset = 8;

  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const body = buffer.subarray(offset + 8, offset + 8 + length);
    offset += 12 + length; // length, type, body, crc

    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      const depth = body[8];
      const colourType = body[9];
      const interlace = body[12];
      if (depth !== 8) throw new Error(`unsupported bit depth ${depth}`);
      if (interlace !== 0) throw new Error('interlaced PNG is not supported');
      if (colourType === 2) channels = 3;
      else if (colourType === 6) channels = 4;
      else throw new Error(`unsupported colour type ${colourType}`);
    } else if (type === 'IDAT') {
      parts.push(body);
    } else if (type === 'IEND') {
      break;
    }
  }

  if (!width || !height || !channels) throw new Error(`${file} had no usable header`);

  const raw = inflateSync(Buffer.concat(parts));
  const stride = width * channels;
  const data = Buffer.alloc(stride * height);

  for (let row = 0; row < height; row += 1) {
    const filter = raw[row * (stride + 1)];
    const source = raw.subarray(row * (stride + 1) + 1, row * (stride + 1) + 1 + stride);
    const target = data.subarray(row * stride, (row + 1) * stride);
    const above = row === 0 ? null : data.subarray((row - 1) * stride, row * stride);

    for (let i = 0; i < stride; i += 1) {
      const left = i >= channels ? target[i - channels] : 0;
      const up = above ? above[i] : 0;
      const upLeft = above && i >= channels ? above[i - channels] : 0;
      let value = source[i];
      if (filter === 1) value += left;
      else if (filter === 2) value += up;
      else if (filter === 3) value += (left + up) >> 1;
      else if (filter === 4) value += paeth(left, up, upLeft);
      else if (filter !== 0) throw new Error(`unknown row filter ${filter}`);
      target[i] = value & 0xff;
    }
  }

  return { width, height, channels, data };
}

/**
 * Where two images differ, as a bounding box and a count.
 *
 * The threshold is per channel and deliberately generous: window contents can shift a shade
 * between two captures without anything meaningful having changed, and counting that as a
 * difference would put the box around the whole image and prove nothing.
 *
 * `skipTop` ignores that many rows from the top. A window's title bar repaints on its own — the
 * close and minimise buttons light up as the pointer passes anywhere near, and macOS animates
 * them — so two captures of an otherwise still window differ up there almost every time. That
 * widened the box until the caller could no longer say a difference was localised, and a run lost
 * the pointer verdict it exists to give: "the window redrew between captures". Nothing had
 * redrawn but the chrome.
 */
export function differenceRegion(a, b, threshold = 24, skipTop = 0) {
  if (a.width !== b.width || a.height !== b.height) {
    throw new Error(`sizes differ: ${a.width}x${a.height} vs ${b.width}x${b.height}`);
  }
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let count = 0;

  for (let y = Math.max(0, Math.floor(skipTop)); y < a.height; y += 1) {
    for (let x = 0; x < a.width; x += 1) {
      const ai = (y * a.width + x) * a.channels;
      const bi = (y * b.width + x) * b.channels;
      const changed =
        Math.abs(a.data[ai] - b.data[bi]) > threshold ||
        Math.abs(a.data[ai + 1] - b.data[bi + 1]) > threshold ||
        Math.abs(a.data[ai + 2] - b.data[bi + 2]) > threshold;
      if (!changed) continue;
      count += 1;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }

  if (count === 0) return { count: 0, box: null };
  return { count, box: { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 } };
}
