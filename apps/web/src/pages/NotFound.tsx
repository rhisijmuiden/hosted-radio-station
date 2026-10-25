import { Compass } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { Button, EmptyState } from '../components/ui';

export function NotFoundPage() {
  const { t } = useTranslation();
  return (
    <EmptyState
      icon={<Compass className="size-6" />}
      title={t('notFound.title')}
      description={t('notFound.text')}
      action={
        <Link to="/">
          <Button variant="dark">{t('notFound.back')}</Button>
        </Link>
      }
    />
  );
}
