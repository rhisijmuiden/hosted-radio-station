import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, type Me } from './api';

export function useMe() {
  const query = useQuery({
    queryKey: ['me'],
    queryFn: () => api<Me>('/auth/me'),
    retry: (count, err) => !(err instanceof ApiError && err.status === 401) && count < 2,
    staleTime: 60_000,
  });
  return query;
}

export function useLogout() {
  const qc = useQueryClient();
  return async () => {
    await api('/auth/logout', { method: 'POST' }).catch(() => undefined);
    qc.clear();
    window.location.href = '/login';
  };
}

export const isAdmin = (me: Me | undefined) => !!me?.user.isSuperadmin;
