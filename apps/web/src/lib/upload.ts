import { api, ApiError } from './api';

/** At most this much per request: under the 100 MB body limit of Cloudflare in front of the panel. */
export const UPLOAD_PART = 16 * 1024 * 1024;
const RETRIES = [2, 4, 8, 16, 30];

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

const wait = (s: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, s * 1000);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    });
  });

/** One part, through XMLHttpRequest for the upload progress. */
function sendPart(url: string, part: Blob, onSent: (bytes: number) => void, signal: AbortSignal) {
  return new Promise<Started>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.setRequestHeader('content-type', 'application/octet-stream');
    xhr.upload.onprogress = (e) => onSent(e.loaded);
    xhr.onload = () => {
      const body = JSON.parse(xhr.responseText || '{}');
      if (xhr.status === 200) resolve(body as Started);
      else reject(new ApiError(xhr.status, body?.error?.code ?? 'error', body?.error?.message ?? xhr.statusText));
    };
    xhr.onerror = () => reject(new ApiError(0, 'network', 'The server cannot be reached'));
    signal.addEventListener('abort', () => xhr.abort());
    xhr.onabort = () => reject(new DOMException('Aborted', 'AbortError'));
    xhr.send(part);
  });
}

/**
 * Uploads one file in parts. Asks the server first how much it already has, so a file that broke off goes on where it
 * stopped; a part that fails is tried again a few times. onProgress gets the bytes the server has.
 */
export async function uploadInParts(stationId: string, folder: string, item: UploadItem, onProgress: (bytes: number) => void, signal: AbortSignal) {
  const begin = () => api<Started>(`/stations/${stationId}/library/uploads`, { method: 'POST', body: { folder, path: item.path, size: item.file.size } });
  let s = await begin();
  let attempt = 0;
  onProgress(s.offset);
  while (!s.done) {
    const part = item.file.slice(s.offset, s.offset + UPLOAD_PART);
    const at = s.offset;
    try {
      s = await sendPart(`/api/stations/${stationId}/library/uploads/${s.id}?offset=${at}`, part, (sent) => onProgress(at + sent), signal);
      attempt = 0;
      onProgress(s.offset);
    } catch (err) {
      if (signal.aborted || (err as Error).name === 'AbortError') throw err;
      const status = err instanceof ApiError ? err.status : 0;
      // Refused for a reason that does not pass (not audio, storage full, no access): stop.
      if (status >= 400 && status < 500 && status !== 404 && status !== 409) throw err;
      if (attempt >= RETRIES.length) throw err;
      await wait(RETRIES[attempt++]!, signal);
      // Out of step (409) or forgotten after a restart (404): the server says again where it stands.
      s = await begin();
      onProgress(s.offset);
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
