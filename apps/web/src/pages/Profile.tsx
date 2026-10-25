import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Avatar, Button, Card, CardHeader, Field, Input, PageHeader, Select } from '../components/ui';
import { setLanguage } from '../i18n';
import { api, ApiError, type Me, type User } from '../lib/api';
import { useMe } from '../lib/auth';

export function ProfilePage() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const me = useMe().data!;
  const [name, setName] = useState(me.user.name);
  const [locale, setLocale] = useState(me.user.locale);
  const [pw, setPw] = useState({ current: '', next: '', repeat: '' });
  const [pwError, setPwError] = useState<string | null>(null);
  useEffect(() => {
    setName(me.user.name);
    setLocale(me.user.locale);
  }, [me.user.name, me.user.locale]);

  const saveProfile = useMutation({
    mutationFn: () => api<User>('/auth/me', { method: 'PATCH', body: { name, locale } }),
    onSuccess: (user) => {
      qc.setQueryData<Me>(['me'], (old) => (old ? { ...old, user } : old));
      void setLanguage(user.locale as 'en' | 'nl', false);
      toast.success(t('common.saved'));
    },
    onError: (err) => toast.error((err as Error).message),
  });

  const changePassword = useMutation({
    mutationFn: () => api('/auth/password', { method: 'POST', body: { currentPassword: pw.current, newPassword: pw.next } }),
    onSuccess: () => {
      setPw({ current: '', next: '', repeat: '' });
      toast.success(t('profile.passwordChanged'));
    },
    onError: (err) => setPwError(err instanceof ApiError ? err.message : String(err)),
  });

  return (
    <>
      <PageHeader title={t('nav.profile')} description={t('profile.subtitle')} />
      <div className="grid max-w-4xl gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title={t('profile.details')} />
          <form
            className="flex flex-col gap-4 p-5"
            onSubmit={(e) => {
              e.preventDefault();
              saveProfile.mutate();
            }}
          >
            <div className="flex items-center gap-3">
              <Avatar name={name || me.user.name} className="size-12 text-base" />
              <div>
                <div className="font-semibold">{me.user.email}</div>
                <div className="text-xs text-muted">{me.user.isSuperadmin ? t('roles.superadmin') : t('roles.user')}</div>
              </div>
            </div>
            <Field label={t('fields.name')}>
              <Input required value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
            <Field label={t('fields.language')}>
              <Select value={locale} onChange={(e) => setLocale(e.target.value)}>
                <option value="en">English</option>
                <option value="nl">Nederlands</option>
              </Select>
            </Field>
            <div className="flex justify-end">
              <Button type="submit" variant="dark" loading={saveProfile.isPending}>
                {t('common.save')}
              </Button>
            </div>
          </form>
        </Card>
        <Card>
          <CardHeader title={t('profile.password')} description={t('profile.passwordHint')} />
          <form
            className="flex flex-col gap-4 p-5"
            onSubmit={(e) => {
              e.preventDefault();
              setPwError(null);
              if (pw.next !== pw.repeat) return setPwError(t('profile.mismatch'));
              changePassword.mutate();
            }}
          >
            <Field label={t('profile.current')}>
              <Input type="password" autoComplete="current-password" required value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} />
            </Field>
            <Field label={t('profile.new')} hint={t('profile.newHint')}>
              <Input type="password" autoComplete="new-password" required minLength={10} value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} />
            </Field>
            <Field label={t('profile.repeat')}>
              <Input type="password" autoComplete="new-password" required value={pw.repeat} onChange={(e) => setPw({ ...pw, repeat: e.target.value })} />
            </Field>
            {pwError && <p className="rounded-md bg-offline/10 px-3 py-2 text-[13px] text-offline">{pwError}</p>}
            <div className="flex justify-end">
              <Button type="submit" variant="dark" loading={changePassword.isPending}>
                {t('profile.change')}
              </Button>
            </div>
          </form>
        </Card>
      </div>
    </>
  );
}
