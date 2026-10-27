import { useSystemInfo } from '../components/InfoDialog';

/**
 * The names of this server and its own roles (phase 18), used instead of "This server". Null until the system info is
 * loaded.
 */
export function useServerNames() {
  return useSystemInfo().data?.server ?? null;
}
