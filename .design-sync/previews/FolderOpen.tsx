// 同梱インラインアイコン(currentColor / lucide 風)。色は親の color トークンで、
// サイズは width/height で制御する。
import { FolderOpen } from '@gantt-flow/desktop';

export const Icon = () => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 18, fontFamily: 'var(--font-ui)' }}>
    <div style={{ color: 'var(--ink)', display: 'flex', alignItems: 'center', gap: 14 }}>
      <FolderOpen width={30} height={30} />
      <span style={{ fontSize: 13, color: 'var(--muted)' }}>FolderOpen</span>
    </div>
    <div style={{ color: 'var(--ink)', display: 'flex', alignItems: 'flex-end', gap: 16 }}>
      <FolderOpen width={16} height={16} />
      <FolderOpen width={20} height={20} />
      <FolderOpen width={24} height={24} />
      <FolderOpen width={32} height={32} />
    </div>
    <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
      <span style={{ color: 'var(--ink)' }}><FolderOpen width={24} height={24} /></span>
      <span style={{ color: 'var(--accent)' }}><FolderOpen width={24} height={24} /></span>
      <span style={{ color: 'var(--muted)' }}><FolderOpen width={24} height={24} /></span>
    </div>
  </div>
);
