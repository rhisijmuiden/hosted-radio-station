import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, type AuthOptions, type Me } from './api';

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

/** Outgoing mail works, so invitations and reset links can be sent. */
export function useMailConfigured() {
  const options = useQuery({ queryKey: ['auth-options'], queryFn: () => api<AuthOptions>('/auth/options'), staleTime: 60_000 });
  return !!options.data?.passwordReset;
}
