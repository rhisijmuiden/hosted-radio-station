import { useLayout } from './layout';

/** Where the Manage view should open: a section, and in it a clock or a block of the schedule. */
export type ManageTarget = { section: 'clocks'; clockId: string | null } | { section: 'schedule'; entryId: string | null };

let pending: ManageTarget | null = null;

/** The target set by another view: the Manage view reads it when it opens, then clears it (reading twice is safe). */
export const peekManageTarget = (): ManageTarget | null => pending;
export const clearManageTarget = () => {
  pending = null;
};

/** Opens the Manage view at a clock or a block, e.g. from the AutoDJ view. */
export function useOpenInManage() {
  const [, setLayout] = useLayout();
  return (target: ManageTarget) => {
    pending = target;
    setLayout({ manage: true });
  };
}
