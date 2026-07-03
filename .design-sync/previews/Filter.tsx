// 同梱インラインアイコン(currentColor / lucide 風)。色は親の color トークンで、
// サイズは width/height で制御する。
import { Filter } from '@gantt-flow/desktop';

export const Icon = () => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 18, fontFamily: 'var(--font-ui)' }}>
    <div style={{ color: 'var(--ink)', display: 'flex', alignItems: 'center', gap: 14 }}>
      <Filter width={30} height={30} />
      <span style={{ fontSize: 13, color: 'var(--muted)' }}>Filter</span>
    </div>
    <div style={{ color: 'var(--ink)', display: 'flex', alignItems: 'flex-end', gap: 16 }}>
      <Filter width={16} height={16} />
      <Filter width={20} height={20} />
      <Filter width={24} height={24} />
      <Filter width={32} height={32} />
    </div>
    <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
      <span style={{ color: 'var(--ink)' }}><Filter width={24} height={24} /></span>
      <span style={{ color: 'var(--accent)' }}><Filter width={24} height={24} /></span>
      <span style={{ color: 'var(--muted)' }}><Filter width={24} height={24} /></span>
    </div>
  </div>
);
