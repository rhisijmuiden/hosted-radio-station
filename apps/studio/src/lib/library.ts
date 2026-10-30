import { useQuery } from '@tanstack/react-query';
import { api, type LibraryFolders, type PlaylistFolder } from './api';

export const useFolders = (id: string | undefined) =>
  useQuery({ queryKey: ['library-folders', id], queryFn: () => api<LibraryFolders>(`/stations/${id}/library/folders`), enabled: !!id, staleTime: 30_000 });

export const sameFolder = (a: PlaylistFolder, b: PlaylistFolder) => a.location === b.location && a.path === b.path;
/** A playlist folder takes in this folder: the folder itself, a parent of it or the whole location. */
export const covers = (by: PlaylistFolder, f: PlaylistFolder) => by.location === f.location && (sameFolder(by, f) || !by.path || f.path.startsWith(`${by.path}/`));

/** The folder tree of every location, built from the folders that hold tracks (the same as the web panel). */
export function folderTree(data: LibraryFolders | undefined) {
  const out: { location: string; path: string; name: string; depth: number; tracks: number }[] = [];
  if (!data) return out;
  for (const loc of data.locations) {
    const paths = new Map<string, number>();
    for (const f of data.folders.filter((x) => x.location === loc.id)) {
      const parts = f.path.split('/');
      for (let i = 1; i <= parts.length; i++) {
        const p = parts.slice(0, i).join('/');
        paths.set(p, (paths.get(p) ?? 0) + (i === parts.length ? f.tracks : 0));
      }
    }
    for (const p of [...paths.keys()].sort((a, b) => a.localeCompare(b))) {
      out.push({ location: loc.id, path: p, name: p.split('/').pop()!, depth: p.split('/').length, tracks: paths.get(p)! });
    }
  }
  return out;
}
