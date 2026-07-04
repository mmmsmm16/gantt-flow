// 手順書本文（ProcedureStep.bodyMd）用の最小 Markdown レンダラ。
// React 要素を組み立てる方式で dangerouslySetInnerHTML は使わない＝XSS 安全
// （テキストは常に React の子として渡すのでエスケープされる。<script> はただの文字列になる）。
//
// 対応記法（それ以外はプレーンテキストとして出す）:
//  - 段落: 空行区切り（1 つ以上の空行でブロックを分ける）
//  - 箇条書き: 行頭 "- "
//  - 番号付き: 行頭 "1. "（数字 + ". "）
//  - 強調: **太字**
//  - 行内コード: `コード`
//  - 改行: 段落内の行末（<br/>）
import type { ReactNode } from 'react';
import { Fragment } from 'react';

// 行内記法（**太字** / `コード`）をトークン化して React 要素へ。太字/コードの中身は
// プレーンテキスト（入れ子は解釈しない＝最小仕様）。閉じ記号が無ければ素の文字として残す。
function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const out: ReactNode[] = [];
  let buf = '';
  let i = 0;
  let k = 0;
  const flush = () => {
    if (buf) {
      out.push(buf);
      buf = '';
    }
  };
  while (i < text.length) {
    if (text.startsWith('**', i)) {
      const end = text.indexOf('**', i + 2);
      if (end !== -1) {
        flush();
        out.push(<strong key={`${keyPrefix}-b${k++}`}>{text.slice(i + 2, end)}</strong>);
        i = end + 2;
        continue;
      }
    }
    if (text[i] === '`') {
      const end = text.indexOf('`', i + 1);
      if (end !== -1) {
        flush();
        out.push(<code key={`${keyPrefix}-c${k++}`}>{text.slice(i + 1, end)}</code>);
        i = end + 1;
        continue;
      }
    }
    buf += text[i];
    i += 1;
  }
  flush();
  return out;
}

// 段落: 行を <br/> で連結（行末改行）。各行は行内記法を解釈。
function renderParagraph(lines: string[], key: string): ReactNode {
  const children: ReactNode[] = [];
  lines.forEach((line, idx) => {
    if (idx > 0) children.push(<br key={`${key}-br${idx}`} />);
    children.push(...renderInline(line, `${key}-l${idx}`));
  });
  return (
    <p className="md-p" key={key}>
      {children}
    </p>
  );
}

const BULLET = /^-\s+(.*)$/;
const NUMBER = /^\d+\.\s+(.*)$/;

// ブロック内を「連続する箇条書き / 番号付き / 段落」の区間に分けて描画する。
// 例: 「見出し行\n- a\n- b」は 段落(見出し行) ＋ <ul>（a,b）に分かれる（Excel からの素朴な
// 手順書き＝1 行導入＋箇条書きを、空行を挟まなくても素直にリスト化する）。
function renderBlock(block: string, key: string): ReactNode {
  const lines = block.split('\n');
  const segments: ReactNode[] = [];
  let i = 0;
  let seg = 0;
  const isBullet = (l: string) => BULLET.test(l.trim());
  const isNumber = (l: string) => NUMBER.test(l.trim());
  while (i < lines.length) {
    if (isBullet(lines[i]!)) {
      const items: string[] = [];
      while (i < lines.length && isBullet(lines[i]!)) items.push(lines[i]!.trim().replace(BULLET, '$1')), i++;
      const sk = `${key}-s${seg++}`;
      segments.push(
        <ul className="md-ul" key={sk}>
          {items.map((it, j) => (
            <li key={`${sk}-li${j}`}>{renderInline(it, `${sk}-li${j}`)}</li>
          ))}
        </ul>,
      );
    } else if (isNumber(lines[i]!)) {
      const items: string[] = [];
      while (i < lines.length && isNumber(lines[i]!)) items.push(lines[i]!.trim().replace(NUMBER, '$1')), i++;
      const sk = `${key}-s${seg++}`;
      segments.push(
        <ol className="md-ol" key={sk}>
          {items.map((it, j) => (
            <li key={`${sk}-li${j}`}>{renderInline(it, `${sk}-li${j}`)}</li>
          ))}
        </ol>,
      );
    } else {
      const para: string[] = [];
      while (i < lines.length && !isBullet(lines[i]!) && !isNumber(lines[i]!)) para.push(lines[i]!), i++;
      if (para.some((l) => l.trim() !== '')) segments.push(renderParagraph(para, `${key}-s${seg++}`));
    }
  }
  return <Fragment key={key}>{segments}</Fragment>;
}

export function MarkdownLite({ text }: { text: string }): JSX.Element {
  // 空行（空白のみ含む行も可）で段落に分割。前後の空行は落とす。
  const blocks = text.split(/\n[ \t]*\n/).map((b) => b.replace(/^\n+|\n+$/g, '')).filter((b) => b.trim() !== '');
  return (
    <Fragment>
      {blocks.map((block, i) => renderBlock(block, `md${i}`))}
    </Fragment>
  );
}
