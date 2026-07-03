// 同梱インラインアイコン(currentColor / lucide 風)。色は親の color トークンで、
// サイズは width/height で制御する。
import { Image } from '@gantt-flow/desktop';

export const Icon = () => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 18, fontFamily: 'var(--font-ui)' }}>
    <div style={{ color: 'var(--ink)', display: 'flex', alignItems: 'center', gap: 14 }}>
      <Image width={30} height={30} />
      <span style={{ fontSize: 13, color: 'var(--muted)' }}>Image</span>
    </div>
    <div style={{ color: 'var(--ink)', display: 'flex', alignItems: 'flex-end', gap: 16 }}>
      <Image width={16} height={16} />
      <Image width={20} height={20} />
      <Image width={24} height={24} />
      <Image width={32} height={32} />
    </div>
    <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
      <span style={{ color: 'var(--ink)' }}><Image width={24} height={24} /></span>
      <span style={{ color: 'var(--accent)' }}><Image width={24} height={24} /></span>
      <span style={{ color: 'var(--muted)' }}><Image width={24} height={24} /></span>
    </div>
  </div>
);
