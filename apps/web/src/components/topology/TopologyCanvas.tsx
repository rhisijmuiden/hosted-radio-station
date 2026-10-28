import { Maximize2, Minus, Plus } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { TopologyScene, type SceneData, type ScenePalette } from './scene';

function readPalette(dark: boolean): ScenePalette {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  return {
    koraal: v('--koraal', '#FF6B57'),
    lucht: v('--lucht', '#9CC3FF'),
    ink: v('--ink', dark ? '#EEF1F7' : '#14213D'),
    muted: v('--ink-muted', '#4F5B73'),
    line: dark ? '#22304d' : '#d3d9e6',
    tile: dark ? '#1C2A48' : '#FFFFFF',
    coreTile: dark ? '#22325A' : '#14213D',
    online: v('--status-online', '#1C8A57'),
    warning: v('--status-warning', '#A86B00'),
    offline: v('--status-offline', '#C23434'),
    dark,
  };
}

/** The WebGL view; loaded on its own so the rest of the panel stays light. */
export default function TopologyCanvas({
  data,
  selected,
  onSelect,
  dark,
  showControl,
  showLabels,
}: {
  data: SceneData;
  selected: string | null;
  onSelect: (id: string | null) => void;
  dark: boolean;
  /** Every control line, or only those of the selected block. */
  showControl: boolean;
  /** Server labels on the towers (the selected one always keeps its label). */
  showLabels: boolean;
}) {
  const { t } = useTranslation();
  const host = useRef<HTMLDivElement>(null);
  const scene = useRef<TopologyScene | null>(null);
  const select = useRef(onSelect);
  select.current = onSelect;

  useEffect(() => {
    if (!host.current) return;
    const s = new TopologyScene(host.current, readPalette(dark), (id) => select.current(id));
    scene.current = s;
    return () => {
      s.dispose();
      scene.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => scene.current?.setPalette(readPalette(dark)), [dark]);
  useEffect(() => scene.current?.setControl(showControl), [showControl]);
  useEffect(() => scene.current?.setLabels(showLabels), [showLabels]);
  useEffect(() => scene.current?.setData(data), [data]);
  useEffect(() => scene.current?.setSelected(selected), [selected]);

  const tool = 'grid size-9 place-items-center rounded-md border border-line bg-raised text-muted shadow-sm hover:bg-hover hover:text-ink';
  return (
    <>
      <div ref={host} className="absolute inset-0 touch-none" />
      <div className="absolute right-3 bottom-3 flex gap-1.5">
        <button type="button" className={tool} title={t('topology.zoomIn')} onClick={() => scene.current?.zoom(0.8)}>
          <Plus className="size-4" />
        </button>
        <button type="button" className={tool} title={t('topology.zoomOut')} onClick={() => scene.current?.zoom(1.25)}>
          <Minus className="size-4" />
        </button>
        <button type="button" className={tool} title={t('topology.reset')} onClick={() => scene.current?.reset()}>
          <Maximize2 className="size-4" />
        </button>
      </div>
    </>
  );
}
