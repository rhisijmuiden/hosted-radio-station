import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, forgetKey, loadKey, setApiKey, setOnUnauthorized, type Me, type StationListItem } from './api';
import { call, type AppInfo } from './native';
import { getSettings, updateSettings, useSettings } from './settings';

interface Session {
  app: AppInfo | null;
  /** null while starting; false = not signed in. */
  me: Me | null | false;
  stations: StationListItem[];
  station: StationListItem | null;
  chooseStation: (id: string) => void;
  signedIn: (server: string, key: string) => Promise<void>;
  signOut: () => Promise<void>;
}

const SessionContext = createContext<Session>(null as unknown as Session);
export const useSession = () => useContext(SessionContext);

export function SessionProvider({ children }: { children: ReactNode }) {
  const settings = useSettings();
  const qc = useQueryClient();
  const [app, setApp] = useState<AppInfo | null>(null);
  const [me, setMe] = useState<Me | null | false>(null);

  const boot = useCallback(async () => {
    const server = getSettings().server;
    const key = server ? await loadKey(server).catch(() => null) : null;
    if (!server || !key) {
      setApiKey(null);
      setMe(false);
      return;
    }
    setApiKey(key);
    try {
      const m = await api<Me>('/auth/me');
      setMe(m);
      void api('/studio/hello', { method: 'POST', body: { clientVersion: (await call<AppInfo>('app_info')).version } }).catch(() => undefined);
    } catch {
      setMe(false);
    }
  }, []);

  useEffect(() => {
    void call<AppInfo>('app_info').then(setApp);
    setOnUnauthorized(() => setMe(false));
    void boot();
  }, [boot]);

  const stations = useQuery({
    queryKey: ['stations', settings.server],
    queryFn: () => api<StationListItem[]>('/stations'),
    enabled: !!me,
    refetchInterval: 15_000,
  });
  const list = stations.data ?? [];
  const station = list.find((s) => s.id === settings.stationId) ?? list[0] ?? null;

  const value: Session = {
    app,
    me,
    stations: list,
    station,
    chooseStation: (id) => updateSettings({ stationId: id }),
    signedIn: async (server, key) => {
      updateSettings({ server });
      setApiKey(key);
      await boot();
    },
    signOut: async () => {
      const server = getSettings().server;
      await api('/studio/session', { method: 'DELETE' }).catch(() => undefined);
      await forgetKey(server).catch(() => undefined);
      setApiKey(null);
      qc.clear();
      setMe(false);
    },
  };
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}
