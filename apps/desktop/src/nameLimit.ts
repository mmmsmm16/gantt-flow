// 工程名のソフト上限（120字）。入力は拒否せず、超過時に赤リング（.name-overlong）＋title で
// 気づかせるだけ（B-15）。TableView / FullTable / FlowCanvas のインラインリネーム入力で共通利用。
// （Inspector の工程名は読み取り専用テキストのため対象外＝入力欄が無い。）
import type { FormEvent } from 'react';

export const TASK_NAME_SOFT_LIMIT = 120;
export const NAME_OVERLONG_CLASS = 'name-overlong';
export const NAME_OVERLONG_TITLE = `工程名が長すぎます（${TASK_NAME_SOFT_LIMIT}字以下を推奨）`;

export function isNameOverLimit(name: string | null | undefined): boolean {
  return (name?.length ?? 0) > TASK_NAME_SOFT_LIMIT;
}

/** 既存 className へ連結する用（超過時のみ ' name-overlong' を返す。初回描画の反映）。 */
export function nameLenClass(name: string | null | undefined): string {
  return isNameOverLimit(name) ? ` ${NAME_OVERLONG_CLASS}` : '';
}

/** 超過時に付ける title（そうでなければ undefined）。初回描画の反映。 */
export function nameLenTitle(name: string | null | undefined): string | undefined {
  return isNameOverLimit(name) ? NAME_OVERLONG_TITLE : undefined;
}

/** 非制御 input 向けの onInput。打鍵中は再レンダされないので、警告リングと title を
    そのたび DOM へ直接反映する（初回状態は nameLenClass / nameLenTitle が担う）。 */
export function onNameInput(e: FormEvent<HTMLInputElement>): void {
  const el = e.currentTarget;
  const over = isNameOverLimit(el.value);
  el.classList.toggle(NAME_OVERLONG_CLASS, over);
  if (over) el.title = NAME_OVERLONG_TITLE;
  else el.removeAttribute('title');
}
