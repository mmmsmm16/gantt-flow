import type { ProcessTask, Id } from '@gantt-flow/core';
import { groupPrevCandidates } from './suggestions';

// 前工程／次工程セレクトの <option> 群。候補が複数の親グループにまたがるときだけ <optgroup> で
// 区切り、どのグループの工程かを見分けられるようにする（同粒度の別グループへ依存を張れるよう
// 候補を広げた B2 のための表示。単一グループなら従来どおりフラットなオプション）。
export function PrevCandidateOptions({
  candidates,
  parentName,
}: {
  candidates: ProcessTask[];
  /** 親 ID → グループ見出し（親なし＝最上位のときは parentId が undefined）。 */
  parentName: (parentId: Id | undefined) => string;
}) {
  const groups = groupPrevCandidates(candidates);
  if (groups.length <= 1) {
    return (
      <>
        {candidates.map((o) => (
          <option key={o.id} value={o.id}>
            {o.name}
          </option>
        ))}
      </>
    );
  }
  return (
    <>
      {groups.map((g) => (
        <optgroup key={g.parentId ?? '_root'} label={parentName(g.parentId)}>
          {g.tasks.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
            </option>
          ))}
        </optgroup>
      ))}
    </>
  );
}
