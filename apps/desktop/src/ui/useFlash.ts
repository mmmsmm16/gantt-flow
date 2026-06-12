// 同期フラッシュの点灯管理。store の「seq 付き ID リスト」（lastSyncAdded / lastAssigneeSync）を
// 一定時間だけ点灯する Set に変換する。seq が進むたびに張り直す＝連続編集では最新の追加だけが光る。
// 消灯時間は styles.css の sync-flash アニメーション（1.5s）と対応させる。
import { useEffect, useRef, useState } from 'react';

export const FLASH_MS = 1500;

export function useFlashIds(src: { ids: readonly string[]; seq: number }): ReadonlySet<string> {
  const [lit, setLit] = useState<ReadonlySet<string>>(() => new Set());
  // マウント時点の seq は「消費済み」として扱う: ビュー切替などで再マウントしても
  // 過去の同期が再点灯しないよう、新しい seq に進んだときだけ光らせる。
  const seen = useRef(src.seq);
  useEffect(() => {
    if (src.seq === seen.current) return undefined;
    seen.current = src.seq; // 空 ids（adopt のリセット等）でも消費済みにする
    if (src.ids.length === 0) return undefined;
    setLit(new Set(src.ids));
    const t = window.setTimeout(() => setLit(new Set()), FLASH_MS);
    return () => window.clearTimeout(t);
  }, [src]);
  return lit;
}
