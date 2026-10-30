import { useQuery } from '@tanstack/react-query';
import { api, type Account, type AutoDj, type Played, type Rundown, type StationDetail, type StationNetwork, type StationRouting, type StationStatus } from './api';

export const useStationDetail = (id: string | undefined) =>
  useQuery({ queryKey: ['station', id], queryFn: () => api<StationDetail>(`/stations/${id}`), enabled: !!id, staleTime: 30_000 });

export const useStatus = (id: string | undefined) =>
  useQuery({ queryKey: ['status', id], queryFn: () => api<StationStatus>(`/stations/${id}/status`), enabled: !!id, refetchInterval: 4000 });

export const useAutoDj = (id: string | undefined) =>
  useQuery({ queryKey: ['autodj', id], queryFn: () => api<AutoDj>(`/stations/${id}/autodj`), enabled: !!id, refetchInterval: 2000 });

export const useRundown = (id: string | undefined, enabled = true) =>
  useQuery({ queryKey: ['rundown', id], queryFn: () => api<Rundown>(`/stations/${id}/autodj/rundown?hours=3`), enabled: !!id && enabled, refetchInterval: 30_000 });

export const useAccounts = (id: string | undefined) =>
  useQuery({ queryKey: ['accounts', id], queryFn: () => api<Account[]>(`/stations/${id}/accounts`), enabled: !!id, staleTime: 60_000 });

/** Last played, for the log of the OmniPlayer layout; refetched when the track on air changes. */
export const useHistory = (id: string | undefined, onAir: string | undefined, enabled = true) =>
  useQuery({ queryKey: ['history', id, onAir], queryFn: () => api<{ items: Played[] }>(`/stations/${id}/autodj/history?limit=8`), enabled: !!id && enabled, staleTime: 60_000, placeholderData: (prev) => prev });

/** The nodes of the station and their health, for the Manage view. */
export const useNetwork = (id: string | undefined) =>
  useQuery({ queryKey: ['network', id], queryFn: () => api<StationNetwork>(`/stations/${id}/network`), enabled: !!id, refetchInterval: 10_000 });

export const useRouting = (id: string | undefined) =>
  useQuery({ queryKey: ['routing', id], queryFn: () => api<StationRouting>(`/stations/${id}/routing`), enabled: !!id, refetchInterval: 10_000 });
