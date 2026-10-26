import { useQuery } from '@tanstack/react-query';
import { api, type Account, type AutoDj, type StationDetail, type StationStatus } from './api';

export const useStationDetail = (id: string | undefined) =>
  useQuery({ queryKey: ['station', id], queryFn: () => api<StationDetail>(`/stations/${id}`), enabled: !!id, staleTime: 30_000 });

export const useStatus = (id: string | undefined) =>
  useQuery({ queryKey: ['status', id], queryFn: () => api<StationStatus>(`/stations/${id}/status`), enabled: !!id, refetchInterval: 4000 });

export const useAutoDj = (id: string | undefined) =>
  useQuery({ queryKey: ['autodj', id], queryFn: () => api<AutoDj>(`/stations/${id}/autodj`), enabled: !!id, refetchInterval: 2000 });

export const useAccounts = (id: string | undefined) =>
  useQuery({ queryKey: ['accounts', id], queryFn: () => api<Account[]>(`/stations/${id}/accounts`), enabled: !!id, staleTime: 60_000 });
