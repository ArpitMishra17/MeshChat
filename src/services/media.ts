/**
 * Native-facing helpers for photo and voice attachments: downscale/compress
 * images, read recordings, and store attachment bytes under the app documents
 * directory. Pure byte logic lives in mediaAssembler.ts.
 */
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import { Directory, File, Paths } from 'expo-file-system';
import { AudioQuality, IOSOutputFormat, type RecordingOptions } from 'expo-audio';
import type { MediaKind, MediaMeta } from '../types';
import { MAX_MEDIA_BYTES, MEDIA_CHUNK_BYTES } from './protocol';

const IMAGE_MAX_SIDE = 640;
/** Tried in order until the JPEG fits MAX_MEDIA_BYTES. */
const IMAGE_QUALITY_LADDER = [0.55, 0.45, 0.35, 0.25];

export const MAX_VOICE_MS = 20_000;

/**
 * Mono 16 kHz AAC in an m4a container at ~24 kbps, sized for voice over BLE.
 * Based on expo-audio's RecordingPresets.LOW_QUALITY, with the sample rate and
 * bit rate lowered to fit the mesh's throughput budget.
 */
export const VOICE_RECORDING_OPTIONS: RecordingOptions = {
  extension: '.m4a',
  sampleRate: 16_000,
  numberOfChannels: 1,
  bitRate: 24_000,
  isMeteringEnabled: false,
  android: {
    extension: '.m4a',
    outputFormat: 'mpeg4',
    audioEncoder: 'aac',
    sampleRate: 16_000,
  },
  ios: {
    extension: '.m4a',
    outputFormat: IOSOutputFormat.MPEG4AAC,
    audioQuality: AudioQuality.LOW,
    sampleRate: 16_000,
    linearPCMBitDepth: 16,
    linearPCMIsBigEndian: false,
    linearPCMIsFloat: false,
  },
  web: {
    mimeType: 'audio/webm',
    bitsPerSecond: 24_000,
  },
};

const MIME_BY_EXT: Record<string, string> = {
  m4a: 'audio/mp4',
  mp4: 'audio/mp4',
  aac: 'audio/aac',
  '3gp': 'audio/3gpp',
  caf: 'audio/x-caf',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  webm: 'audio/webm',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
};

const EXT_BY_MIME: Record<string, string> = {
  'audio/mp4': 'm4a',
  'audio/aac': 'aac',
  'audio/3gpp': '3gp',
  'audio/x-caf': 'caf',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'audio/ogg': 'ogg',
  'audio/webm': 'webm',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

function chunkCount(size: number): number {
  return Math.ceil(size / MEDIA_CHUNK_BYTES);
}

function extOf(uri: string): string {
  const m = /\.([A-Za-z0-9]+)$/.exec(uri.split('?')[0]);
  return m ? m[1].toLowerCase() : '';
}

/** Downscale (longest side <= 640), JPEG-compress, and return bytes plus meta. */
export async function prepareImage(pickerUri: string): Promise<{ bytes: Uint8Array; meta: MediaMeta }> {
  // The first render gives the true dimensions; the second works from that
  // decoded image so the source is not decoded twice from the picker file.
  const original = await ImageManipulator.manipulate(pickerUri).renderAsync();
  const longest = Math.max(original.width, original.height);

  let ctx = ImageManipulator.manipulate(original);
  if (longest > IMAGE_MAX_SIDE) {
    ctx = ctx.resize(original.width >= original.height ? { width: IMAGE_MAX_SIDE } : { height: IMAGE_MAX_SIDE });
  }
  const rendered = await ctx.renderAsync();

  for (const quality of IMAGE_QUALITY_LADDER) {
    const saved = await rendered.saveAsync({ format: SaveFormat.JPEG, compress: quality });
    const file = new File(saved.uri);
    const bytes = await file.bytes();
    deleteQuietly(file);
    if (bytes.length <= MAX_MEDIA_BYTES) {
      return {
        bytes,
        meta: {
          kind: 'image',
          size: bytes.length,
          chunks: chunkCount(bytes.length),
          mime: 'image/jpeg',
          width: saved.width,
          height: saved.height,
        },
      };
    }
  }
  throw new Error(`image still larger than ${MAX_MEDIA_BYTES} bytes after compression`);
}

/** Read a finished recording and describe it. Throws if it exceeds MAX_MEDIA_BYTES. */
export async function prepareAudio(recordingUri: string, durationMs: number): Promise<{ bytes: Uint8Array; meta: MediaMeta }> {
  const file = new File(recordingUri);
  if (!file.exists) throw new Error('recording file missing');
  if (file.size > MAX_MEDIA_BYTES) throw new Error(`recording is ${file.size} bytes, limit ${MAX_MEDIA_BYTES}`);
  const bytes = await file.bytes();
  if (bytes.length === 0) throw new Error('recording is empty');
  if (bytes.length > MAX_MEDIA_BYTES) throw new Error(`recording is ${bytes.length} bytes, limit ${MAX_MEDIA_BYTES}`);
  const mime = MIME_BY_EXT[extOf(recordingUri)] ?? 'audio/mp4';
  return {
    bytes,
    meta: {
      kind: 'audio',
      size: bytes.length,
      chunks: chunkCount(bytes.length),
      mime,
      durationMs,
    },
  };
}

/** Write attachment bytes to `documents/media/<messageId>.<ext>` and return its file:// uri. */
export async function saveMediaBytes(messageId: string, kind: MediaKind, bytes: Uint8Array, mime: string): Promise<string> {
  const dir = new Directory(Paths.document, 'media');
  dir.create({ idempotent: true, intermediates: true });
  const ext = EXT_BY_MIME[mime] ?? (kind === 'image' ? 'jpg' : 'm4a');
  const safeId = messageId.replace(/[^A-Za-z0-9_-]/g, '_');
  const file = new File(dir, `${safeId}.${ext}`);
  file.create({ overwrite: true, intermediates: true });
  file.write(bytes);
  return file.uri;
}

export async function readMediaBytes(uri: string): Promise<Uint8Array> {
  return new File(uri).bytes();
}

/** Best effort: missing files and malformed uris are ignored. */
export async function deleteMediaFile(uri: string | null | undefined): Promise<void> {
  if (!uri) return;
  try {
    const file = new File(uri);
    if (file.exists) file.delete();
  } catch (e) {
    console.warn('[media] delete failed', e);
  }
}

function deleteQuietly(file: File): void {
  try {
    if (file.exists) file.delete();
  } catch {
    // Temp file in the cache directory; the OS reclaims it anyway.
  }
}
