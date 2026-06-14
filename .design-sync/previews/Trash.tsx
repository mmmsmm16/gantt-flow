// 同梱インラインアイコン(currentColor / lucide 風)。色は親の color トークンで、
// サイズは width/height で制御する。
import { Trash } from '@gantt-flow/desktop';

export const Icon = () => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 18, fontFamily: 'var(--font-ui)' }}>
    <div style={{ color: 'var(--ink)', display: 'flex', alignItems: 'center', gap: 14 }}>
      <Trash width={30} height={30} />
      <span style={{ fontSize: 13, color: 'var(--muted)' }}>Trash</span>
    </div>
    <div style={{ color: 'var(--ink)', display: 'flex', alignItems: 'flex-end', gap: 16 }}>
      <Trash width={16} height={16} />
      <Trash width={20} height={20} />
      <Trash width={24} height={24} />
      <Trash width={32} height={32} />
    </div>
    <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
      <span style={{ color: 'var(--ink)' }}><Trash width={24} height={24} /></span>
      <span style={{ color: 'var(--accent)' }}><Trash width={24} height={24} /></span>
      <span style={{ color: 'var(--muted)' }}><Trash width={24} height={24} /></span>
    </div>
  </div>
);
