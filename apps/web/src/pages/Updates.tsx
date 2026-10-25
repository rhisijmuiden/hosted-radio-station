import { useTranslation } from 'react-i18next';
import { UpdatePanel } from '../components/InfoDialog';
import { Card, PageHeader } from '../components/ui';

export function UpdatesPage() {
  const { t } = useTranslation();
  return (
    <>
      <PageHeader title={t('nav.updates')} description={t('info.subtitle')} />
      <Card className="max-w-2xl p-5">
        <UpdatePanel />
      </Card>
    </>
  );
}
