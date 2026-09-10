import { PublicError, ProviderError } from './security';
import { MAX_PHOTO, type VideoFormat, type VideoRatio } from './types';

export function videoRatio(format: VideoFormat, width: number, height: number): VideoRatio {
  dimensions(width, height);
  if (format === 'vertical') return '9:16';
  if (format === 'horizontal') return '16:9';
  if (width === height) return '1:1';
  const ratios: VideoRatio[] = width > height ? ['4:3', '16:9', '21:9'] : ['3:4', '9:16'];
  const distance = (ratio: VideoRatio) => {
    const [w, h] = ratio.split(':').map(Number) as [number, number];
    return Math.abs(Math.log((width / height) / (w / h)));
  };
  return ratios.reduce((nearest, ratio) => distance(ratio) < distance(nearest) ? ratio : nearest);
}

function dimensions(width: number, height: number): { width: number; height: number } {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > 12_000 ||
    height > 12_000 ||
    width * height > 24_000_000
  )
    throw new ProviderError('invalid');
  return { width, height };
}
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}
// Validate the PNG container, dimensions, CRCs and required chunks. Color/profile and
// other ordinary ancillary chunks are valid PNG; a tiny metadata allowlist is not.
export function png(bytes: Uint8Array): { width: number; height: number } {
  if (bytes.length < 57 || [137, 80, 78, 71, 13, 10, 26, 10].some((n, i) => bytes[i] !== n))
    throw new ProviderError('invalid');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 8;
  let result: { width: number; height: number } | undefined;
  let data = false;
  while (offset + 12 <= bytes.length) {
    const length = view.getUint32(offset);
    const end = offset + 12 + length;
    if (end > bytes.length) throw new ProviderError('invalid');
    const name = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    if (
      !/^[A-Za-z]{4}$/.test(name) ||
      crc32(bytes.subarray(offset + 4, end - 4)) !== view.getUint32(end - 4)
    )
      throw new ProviderError('invalid');
    if (offset === 8 && name !== 'IHDR') throw new ProviderError('invalid');
    if (name === 'IHDR') {
      if (result || length !== 13) throw new ProviderError('invalid');
      result = dimensions(view.getUint32(offset + 8), view.getUint32(offset + 12));
      if (bytes[offset + 18] !== 0 || bytes[offset + 19] !== 0 || bytes[offset + 20]! > 1)
        throw new ProviderError('invalid');
    }
    if (name === 'IDAT' && length > 0) data = true;
    if (name === 'IEND') {
      if (!result || !data || length !== 0 || end !== bytes.length)
        throw new ProviderError('invalid');
      return result;
    }
    offset = end;
  }
  throw new ProviderError('invalid');
}
function jpeg(bytes: Uint8Array): { width: number; height: number } {
  if (bytes[0] !== 255 || bytes[1] !== 216 || bytes.at(-2) !== 255 || bytes.at(-1) !== 217)
    throw new ProviderError('invalid');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 2;
  let orientation = 1;
  let size: { width: number; height: number } | undefined;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 255) throw new ProviderError('invalid');
    while (bytes[offset] === 255) offset++;
    const marker = bytes[offset++]!;
    if (marker === 0xda || marker === 0xd9 || offset + 2 > bytes.length) break;
    const length = view.getUint16(offset);
    if (length < 2 || offset + length > bytes.length) throw new ProviderError('invalid');
    if (marker === 0xe1 && length >= 16 &&
      String.fromCharCode(...bytes.subarray(offset + 2, offset + 8)) === 'Exif\0\0') {
      // Read only the bounded primary TIFF orientation; pixel decoding stays with
      // the browser/provider. Native camera JPEGs can store rotated pixels.
      const start = offset + 8;
      const end = offset + length;
      const order = view.getUint16(start);
      if (order !== 0x4949 && order !== 0x4d4d) throw new ProviderError('invalid');
      const little = order === 0x4949;
      if (view.getUint16(start + 2, little) !== 42) throw new ProviderError('invalid');
      const directory = start + view.getUint32(start + 4, little);
      if (directory < start + 8 || directory + 2 > end) throw new ProviderError('invalid');
      const count = view.getUint16(directory, little);
      if (directory + 2 + count * 12 > end) throw new ProviderError('invalid');
      for (let i = 0; i < count; i++) {
        const entry = directory + 2 + i * 12;
        if (view.getUint16(entry, little) !== 0x0112) continue;
        if (view.getUint16(entry + 2, little) !== 3 || view.getUint32(entry + 4, little) !== 1)
          throw new ProviderError('invalid');
        orientation = view.getUint16(entry + 8, little);
        if (orientation < 1 || orientation > 8) throw new ProviderError('invalid');
      }
    }
    if ([0xc0, 0xc1, 0xc2].includes(marker)) {
      if (length < 8) throw new ProviderError('invalid');
      size = dimensions(view.getUint16(offset + 5), view.getUint16(offset + 3));
    }
    offset += length;
  }
  if (size) return orientation >= 5 ? { width: size.height, height: size.width } : size;
  throw new ProviderError('invalid');
}
export async function photo(
  file: File,
): Promise<{ bytes: Uint8Array; type: 'image/jpeg' | 'image/png'; width: number; height: number }> {
  if (!file.size || file.size > MAX_PHOTO)
    throw new PublicError(413, 'Choose JPG or PNG photos up to 5 MB each.');
  const bytes = new Uint8Array(await file.arrayBuffer());
  try {
    if (file.type === 'image/png') {
      return { bytes, type: 'image/png', ...png(bytes) };
    }
    if (file.type === 'image/jpeg') {
      return { bytes, type: 'image/jpeg', ...jpeg(bytes) };
    }
  } catch {
    /* Return only a safe, customer-readable message. */
  }
  throw new PublicError(400, 'Please choose a valid JPG or PNG photo.');
}

// Inspect ISO-BMFF structure and the actual video track, not provider JSON claims.
// Pixel/audio semantics remain a provider qualification and playback check.
export function mp4(bytes: Uint8Array, expectedRatio: VideoRatio = '9:16'): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  type Box = { name: string; start: number; end: number };
  const boxes = (start: number, end: number): Box[] => {
    const list: Box[] = [];
    while (start + 8 <= end) {
      let size = view.getUint32(start);
      let header = 8;
      const name = String.fromCharCode(...bytes.subarray(start + 4, start + 8));
      if (size === 1) {
        if (start + 16 > end) throw new ProviderError('invalid');
        const big = view.getBigUint64(start + 8);
        if (big > BigInt(bytes.length)) throw new ProviderError('invalid');
        size = Number(big);
        header = 16;
      } else if (size === 0) size = end - start;
      if (size < header || start + size > end || list.length > 1000)
        throw new ProviderError('invalid');
      list.push({ name, start: start + header, end: start + size });
      start += size;
    }
    if (start !== end) throw new ProviderError('invalid');
    return list;
  };
  const top = boxes(0, bytes.length);
  if (
    !top.some((b) => b.name === 'ftyp') ||
    !top.some((b) => b.name === 'mdat' && b.end - b.start > 32)
  )
    throw new ProviderError('invalid');
  const movie = top.find((b) => b.name === 'moov');
  if (!movie) throw new ProviderError('invalid');
  let videoTracks = 0;
  for (const track of boxes(movie.start, movie.end).filter((b) => b.name === 'trak')) {
    const children = boxes(track.start, track.end);
    const media = children.find((b) => b.name === 'mdia');
    if (!media) continue;
    const inner = boxes(media.start, media.end);
    const handler = inner.find((b) => b.name === 'hdlr');
    if (!handler || handler.end - handler.start < 12) throw new ProviderError('invalid');
    const kind = String.fromCharCode(...bytes.subarray(handler.start + 8, handler.start + 12));
    if (kind !== 'vide') continue;
    videoTracks++;
    const header = children.find((b) => b.name === 'tkhd');
    const timing = inner.find((b) => b.name === 'mdhd');
    if (!header || header.end - header.start < 84 || !timing || timing.end - timing.start < 24)
      throw new ProviderError('invalid');
    const size = dimensions(view.getUint32(header.end - 8) / 65536,
      view.getUint32(header.end - 4) / 65536);
    const [wide, tall] = expectedRatio.split(':').map(Number) as [number, number];
    // Seedance's 720p 21:9 output is 1470×630; other supported ratios have
    // a short edge of at least 720. Allow 2% ratio rounding for codec alignment.
    const minimumEdge = expectedRatio === '21:9' ? 630 : 720;
    if (Math.min(size.width, size.height) < minimumEdge ||
      Math.abs((size.width / size.height) / (wide / tall) - 1) > 0.02)
      throw new ProviderError('invalid');
    // Rotation/anamorphic display transforms are outside this delivery format.
    const matrix = header.end - 44;
    const identity = [65536, 0, 0, 0, 65536, 0, 0, 0, 1073741824];
    if (identity.some((value, i) => view.getInt32(matrix + i * 4) !== value))
      throw new ProviderError('invalid');
    const version = bytes[timing.start];
    if (version !== 0 && version !== 1) throw new ProviderError('invalid');
    if (version === 1 && timing.end - timing.start < 36) throw new ProviderError('invalid');
    const scale = view.getUint32(timing.start + (version === 1 ? 20 : 12));
    const ticks =
      version === 1
        ? Number(view.getBigUint64(timing.start + 24))
        : view.getUint32(timing.start + 16);
    if (!scale || !Number.isSafeInteger(ticks) || Math.abs(ticks / scale - 15) > 0.2)
      throw new ProviderError('invalid');
  }
  if (videoTracks !== 1) throw new ProviderError('invalid');
}
