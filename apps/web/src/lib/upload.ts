import { api, ApiError } from './api';

/** At most this much per request: under the 100 MB body limit of Cloudflare in front of the panel. */
export const UPLOAD_PART = 16 * 1024 * 1024;
/** Pauses between tries after an outage, in seconds; the last one repeats. */
const RETRIES = [2, 4, 8, 16, 30, 60];
/** An upload that makes no progress for this long (server or connection gone) stops and shows the error. */
const GIVE_UP_MS = 30 * 60 * 1000;

export const AUDIO_EXTENSIONS = ['.mp3', '.aac', '.m4a', '.mp4', '.ogg', '.oga', '.opus', '.flac', '.wav'];
export const isAudio = (name: string) => AUDIO_EXTENSIONS.some((e) => name.toLowerCase().endsWith(e));

/** A file to upload, with its path below the chosen folder (subfolders of a folder upload included). */
export interface UploadItem {
  file: File;
  path: string;
}

interface Started {
  id: string;
  offset: number;
  done: boolean;
}

/** Waits s seconds, or less when the browser reports that its connection is back. */
const wait = (s: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const done = () => {
      clearTimeout(timer);
      window.removeEventListener('online', done);
      resolve();
    };
    const timer = setTimeout(done, s * 1000);
    window.addEventListener('online', done);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      window.removeEventListener('online', done);
      reject(new DOMException('Aborted', 'AbortError'));
    });
  });

/**
 * Whether trying again later can help: no connection, the server or its proxy down or restarting (5xx), a station
 * node that is offline, or an upload the server lost or that got out of step (404/409: begin again). Anything else
 * (not audio, storage full, no access, a station node too old for uploads) stays as it is.
 */
export function passes(err: unknown) {
  if (!(err instanceof ApiError)) return false;
  if (err.code === 'node_outdated') return false;
  const s = err.status;
  return s === 0 || s === 404 || s === 408 || s === 409 || s === 429 || (s >= 500 && s !== 501);
}

/** One part, through XMLHttpRequest for the upload progress. */
function sendPart(url: string, part: Blob, onSent: (bytes: number) => void, signal: AbortSignal) {
  return new Promise<Started>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.setRequestHeader('content-type', 'application/octet-stream');
    xhr.upload.onprogress = (e) => onSent(e.loaded);
    xhr.onload = () => {
      // A proxy in between (Cloudflare, Caddy) answers an outage with an HTML page: no JSON then.
      let body: { error?: { code?: string; message?: string } } & Partial<Started> = {};
      try {
        body = JSON.parse(xhr.responseText || '{}');
      } catch {
        /* not JSON */
      }
      if (xhr.status === 200) resolve(body as Started);
      else reject(new ApiError(xhr.status, body?.error?.code ?? 'error', body?.error?.message ?? xhr.statusText));
    };
    xhr.onerror = () => reject(new ApiError(0, 'network', 'The server cannot be reached'));
    // A part that hangs without an answer counts as a broken connection.
    xhr.timeout = 10 * 60 * 1000;
    xhr.ontimeout = () => reject(new ApiError(0, 'timeout', 'The server did not answer'));
    signal.addEventListener('abort', () => xhr.abort());
    xhr.onabort = () => reject(new DOMException('Aborted', 'AbortError'));
    xhr.send(part);
  });
}

/**
 * Uploads one file in parts. Asks the server first how much it already has, so a file that broke off goes on where it
 * stopped. After an outage it keeps trying by itself, with growing pauses (onWait gets the seconds, 0 when it goes on
 * again), until the server is back or nothing has moved for half an hour. onProgress gets the bytes the server has.
 */
export async function uploadInParts(
  stationId: string,
  folder: string,
  item: UploadItem,
  onProgress: (bytes: number) => void,
  signal: AbortSignal,
  onWait: (seconds: number) => void = () => {},
) {
  const begin = () => api<Started>(`/stations/${stationId}/library/uploads`, { method: 'POST', body: { folder, path: item.path, size: item.file.size } });
  let s: Started | null = null;
  let attempt = 0;
  let moved = Date.now();
  while (!s?.done) {
    try {
      if (!s) {
        s = await begin();
        onProgress(s.offset);
        if (s.done) break;
      }
      const at = s.offset;
      const part = item.file.slice(at, at + UPLOAD_PART);
      s = await sendPart(`/api/stations/${stationId}/library/uploads/${s.id}?offset=${at}`, part, (sent) => onProgress(at + sent), signal);
      onProgress(s.offset);
      attempt = 0;
      moved = Date.now();
    } catch (err) {
      if (signal.aborted || (err as Error).name === 'AbortError') throw err;
      if (!passes(err) || Date.now() - moved > GIVE_UP_MS) throw err;
      const pause = RETRIES[Math.min(attempt++, RETRIES.length - 1)]!;
      onWait(pause);
      await wait(pause, signal);
      onWait(0);
      // Begin again: the server says where it stands (also after a restart, when it forgot the upload).
      s = null;
    }
  }
}

/** The files of a drop, folders included (with their paths). */
export async function droppedItems(data: DataTransfer): Promise<UploadItem[]> {
  const entries = [...data.items].map((i) => i.webkitGetAsEntry?.()).filter((e): e is FileSystemEntry => !!e);
  if (!entries.length) return [...data.files].map((file) => ({ file, path: file.name }));
  const out: UploadItem[] = [];
  const walk = async (entry: FileSystemEntry, prefix: string): Promise<void> => {
    if (entry.isFile) {
      const file = await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject));
      out.push({ file, path: prefix + file.name });
    } else if (entry.isDirectory) {
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      // readEntries gives a folder in batches until an empty one.
      for (;;) {
        const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
        if (!batch.length) break;
        for (const e of batch) await walk(e, `${prefix}${entry.name}/`);
      }
    }
  };
  for (const e of entries) await walk(e, '');
  return out;
}
