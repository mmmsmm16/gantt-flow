# -*- coding: utf-8 -*-
"""Hand-built low-fi UI wireframes for gantt-flow (SVG -> PNG via cairosvg)."""
import cairosvg

FONT = "IPAGothic, sans-serif"

# palette
INK = "#334155"; MUT = "#64748b"; LINE = "#cbd5e1"; HDR = "#f1f5f9"
ACC = "#2563eb"; ACC_FILL = "#dbeafe"
BLU = "#2563eb"; BLU_F = "#dbeafe"
GRN = "#16a34a"; GRN_F = "#dcfce7"
RED = "#dc2626"; RED_F = "#fee2e2"
YEL = "#ca8a04"; YEL_F = "#fef9c3"
NODE = "#475569"; BAND_F = "#f8fafc"; LANE = "#e2e8f0"
ANN = "#aab2bd"  # 課題注釈線: 薄い・矢頭なし


def pline(x1, y1, x2, y2, col=ANN, sw=1.0):
    """plain thin line, no arrowhead (for issue annotation)."""
    return (f'<line x1="{x1}" y1="{y1}" x2="{x2}" y2="{y2}" '
            f'stroke="{col}" stroke-width="{sw}"/>')


def t(x, y, s, size=13, col=INK, w="normal", anchor="start"):
    return (f'<text x="{x}" y="{y}" font-family="{FONT}" font-size="{size}" '
            f'fill="{col}" font-weight="{w}" text-anchor="{anchor}">{s}</text>')


def rect(x, y, w, h, fill="#ffffff", stroke=LINE, rx=4, sw=1.4, dash=None):
    d = f' stroke-dasharray="{dash}"' if dash else ""
    return (f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{rx}" '
            f'fill="{fill}" stroke="{stroke}" stroke-width="{sw}"{d}/>')


def doc(x, y, w, h, stroke, fill, label, lx=None):
    """帳票形: rectangle with wavy bottom."""
    a = 7
    p = (f'M{x},{y} h{w} v{h} '
         f'q{-w/4},{a} {-w/2},0 q{-w/4},{-a} {-w/2},0 z')
    s = f'<path d="{p}" fill="{fill}" stroke="{stroke}" stroke-width="1.6"/>'
    if label:
        s += t(x + w/2, y + h/2 + 4, label, 12, stroke, "bold", "middle")
    return s


def chip(x, y, w, h, stroke, fill, label):
    s = rect(x, y, w, h, fill, stroke, rx=h/2, sw=1.4)
    s += t(x + w/2, y + h/2 + 4, label, 11, stroke, "bold", "middle")
    return s


def diamond(cx, cy, r, stroke=NODE, fill="#ffffff"):
    pts = f"{cx},{cy-r} {cx+r},{cy} {cx},{cy+r} {cx-r},{cy}"
    return f'<polygon points="{pts}" fill="{fill}" stroke="{stroke}" stroke-width="1.6"/>'


def arrow(x1, y1, x2, y2, col=NODE, dash=None, sw=1.8):
    d = f' stroke-dasharray="{dash}"' if dash else ""
    return (f'<line x1="{x1}" y1="{y1}" x2="{x2}" y2="{y2}" stroke="{col}" '
            f'stroke-width="{sw}" marker-end="url(#arr)"{d}/>')


DEFS = ('<defs><marker id="arr" markerWidth="9" markerHeight="9" refX="7" refY="3" '
        'orient="auto" markerUnits="strokeWidth">'
        '<path d="M0,0 L7,3 L0,6 z" fill="#475569"/></marker>'
        '<marker id="arrB" markerWidth="9" markerHeight="9" refX="7" refY="3" '
        'orient="auto" markerUnits="strokeWidth">'
        f'<path d="M0,0 L7,3 L0,6 z" fill="{ACC}"/></marker></defs>')


# ============================================================ Wireframe 1: shell
def shell():
    W, H = 1440, 900
    s = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" '
         f'viewBox="0 0 {W} {H}">', DEFS,
         rect(0, 0, W, H, "#ffffff", "#ffffff", rx=0)]
    # toolbar
    s.append(rect(0, 0, W, 52, HDR, LINE, rx=0))
    s.append(t(24, 33, "gantt-flow", 18, INK, "bold"))
    # granularity segmented control
    segs = ["大", "中", "小", "詳細"]; sx = 560
    s.append(t(sx - 70, 33, "粒度", 13, MUT))
    for i, g in enumerate(segs):
        active = (g == "中")
        s.append(rect(sx + i*54, 14, 54, 26, ACC if active else "#ffffff",
                      ACC if active else LINE, rx=6, sw=1.4))
        s.append(t(sx + i*54 + 27, 31, g, 13, "#ffffff" if active else INK,
                   "bold", "middle"))
    s.append(rect(W - 96, 14, 72, 26, "#ffffff", LINE, rx=6))
    s.append(t(W - 60, 31, "保存", 12, INK, "normal", "middle"))
    s.append(rect(W - 250, 14, 66, 26, "#ffffff", LINE, rx=6))
    s.append(t(W - 217, 31, "戻す", 12, INK, "normal", "middle"))
    s.append(rect(W - 176, 14, 72, 26, "#ffffff", LINE, rx=6))
    s.append(t(W - 140, 31, "やり直し", 12, INK, "normal", "middle"))

    # ---- panes geometry
    top = 64
    tbl_x, tbl_w = 16, 556
    flw_x, flw_w = 588, 612
    ins_x, ins_w = 1216, 208
    pane_h = H - top - 16

    # ===== Table pane
    s.append(rect(tbl_x, top, tbl_w, pane_h, "#ffffff", LINE, rx=8))
    s.append(rect(tbl_x, top, tbl_w, 34, HDR, LINE, rx=8))
    s.append(t(tbl_x + 14, top + 22, "工程表（手順一覧表）", 14, INK, "bold"))
    # column header
    cols = [("工程No", tbl_x+14), ("作業名", tbl_x+86), ("担当", tbl_x+300),
            ("粒度", tbl_x+390), ("工数", tbl_x+460)]
    ch_y = top + 56
    for label, cx in cols:
        s.append(t(cx, ch_y, label, 12, MUT, "bold"))
    s.append(f'<line x1="{tbl_x+10}" y1="{ch_y+8}" x2="{tbl_x+tbl_w-10}" '
             f'y2="{ch_y+8}" stroke="{LINE}" stroke-width="1"/>')
    # rows: (no, name, indent, assignee, level, effort, highlight)
    rows = [
        ("1", "受注処理", 0, "営業部", "大", "2.5h*", False),
        ("1-1", "注文書受付", 1, "営業", "中", "1.0h", True),
        ("1-1-1", "受注内容を確認", 2, "営業", "小", "10分", False),
        ("1-1-2", "在庫を引当", 2, "倉庫", "小", "5分", False),
        ("1-2", "出荷準備", 1, "倉庫", "中", "1.5h", False),
        ("1-2-1", "出荷指示", 2, "倉庫", "小", "5分", False),
    ]
    ry = ch_y + 20
    rh = 30
    hl_row_y = ch_y + 34
    for no, name, ind, asg, lv, eff, hl in rows:
        if hl:
            s.append(rect(tbl_x+8, ry, tbl_w-16, rh, ACC_FILL, ACC, rx=5, sw=1.6))
            hl_row_y = ry + rh/2
        bold = "bold" if ind == 0 else "normal"
        s.append(t(cols[0][1], ry+20, no, 12, INK, bold))
        name_x = cols[1][1] + ind*16
        mky = ry + 15
        if ind < 2:  # expandable parent: small triangle
            s.append(f'<polygon points="{name_x-14},{mky-4} {name_x-14},{mky+4} '
                     f'{name_x-7},{mky}" fill="{MUT}"/>')
        else:        # leaf: small dot
            s.append(f'<circle cx="{name_x-11}" cy="{mky}" r="2.4" fill="{MUT}"/>')
        s.append(t(name_x, ry+20, name, 12, INK, bold))
        s.append(t(cols[2][1], ry+20, asg, 12, INK))
        s.append(t(cols[3][1], ry+20, lv, 12, MUT))
        s.append(t(cols[4][1], ry+20, eff, 12, (MUT if "*" in eff else INK)))
        ry += rh + 4
    s.append(t(tbl_x+14, ry+16, "* 親の工数=子の合計（集計・読み取り専用）", 11, MUT))

    # ===== Flow pane
    s.append(rect(flw_x, top, flw_w, pane_h, "#ffffff", LINE, rx=8))
    s.append(rect(flw_x, top, flw_w, 34, HDR, LINE, rx=8))
    s.append(t(flw_x + 14, top + 22, "工程フロー（中工程・スコープ: 大1 受注処理）",
               14, INK, "bold"))
    # ----- スイムレーン（横）× バンド（縦）のグリッド
    lbl_x = flw_x+14            # 左のレーンラベル列
    grid_left = flw_x+92       # ラベル列の右＝バンド/レーン本体の左端
    grid_right = flw_x+flw_w-16
    band_top = top+86          # バンド見出し帯の上端
    lane_top = top+112         # レーン領域の上端
    lane_mid = top+242         # 営業 / 倉庫 の境界
    lane_bot = top+372         # レーン領域の下端
    # バンド（大: 受注処理）＝縦の祖先範囲。薄い枠＋見出し帯
    s.append(rect(grid_left, band_top, grid_right-grid_left, lane_bot-band_top,
                  BAND_F, LINE, rx=4, dash="6 4"))
    s.append(rect(grid_left, band_top, grid_right-grid_left, 22, HDR, LINE, rx=0))
    s.append(t(grid_left+10, band_top+16, "大: 受注処理（祖先範囲バンド）", 11, MUT))
    # スイムレーン: 薄い水平線で全幅を区切る
    for y in (lane_top, lane_mid, lane_bot):
        s.append(f'<line x1="{lbl_x}" y1="{y}" x2="{grid_right}" y2="{y}" '
                 f'stroke="{LANE}" stroke-width="1.2"/>')
    s.append(f'<line x1="{grid_left}" y1="{lane_top}" x2="{grid_left}" '
             f'y2="{lane_bot}" stroke="{LANE}" stroke-width="1.2"/>')  # ラベル列の縦区切り
    for name, y0, y1 in [("営業", lane_top, lane_mid), ("倉庫", lane_mid, lane_bot)]:
        s.append(t(lbl_x+38, (y0+y1)/2+5, name, 12, INK, "bold", "middle"))
    # nodes（各レーン帯の中央に配置）
    band_x = grid_left
    n1x, n1y = grid_left+118, top+157     # 注文書受付 (営業帯) highlighted
    n2x, n2y = grid_left+216, top+287     # 出荷準備 (倉庫帯)
    # node1: 工程は無色・枠も無彩色。リンク選択は枠を太くするだけ(色は使わない)
    s.append(rect(n1x, n1y, 150, 40, "#ffffff", NODE, rx=6, sw=2.8))
    s.append(t(n1x+75, n1y+25, "注文書受付", 13, INK, "bold", "middle"))
    # I/O は工程の「角に重ねて添える」: 入力=左上 / 出力=右下（接続線なし・重なりOK）
    s.append(doc(n1x-28, n1y-22, 54, 34, BLU, BLU_F, "注文書"))   # 入力: 左上に重ねる
    s.append(doc(n1x+124, n1y+26, 54, 34, GRN, GRN_F, "受付票"))  # 出力: 右下に重ねる
    # arrow node1 -> node2 (営業 → 倉庫, crosses lanes)
    s.append(arrow(n1x+75, n1y+40, n2x+75, n2y-2, NODE))
    # node2
    s.append(rect(n2x, n2y, 150, 40, "#ffffff", NODE, rx=6))
    s.append(t(n2x+75, n2y+25, "出荷準備", 13, INK, "bold", "middle"))
    # issue (red, 直角) — 他オブジェクトと重ならない空きスペース(node2の右)へ配置
    iqx, iqy = n2x+168, n2y+2
    s.append(pline(n2x+150, n2y+20, iqx, iqy+18))      # 細い薄線(矢頭なし)
    s.append(rect(iqx, iqy, 72, 36, RED_F, RED, rx=0))
    s.append(t(iqx+36, iqy+22, "課題", 12, RED, "bold", "middle"))
    # legend mini
    ly0 = top+pane_h-40
    s.append(arrow(flw_x+20, ly0-4, flw_x+50, ly0-4, NODE, sw=2))
    s.append(t(flw_x+58, ly0, "流れ(工程間)", 11, NODE))
    s.append(t(flw_x+150, ly0, "帳票=角に重ねる(入=左上/出=右下)", 11, MUT))
    s.append(pline(flw_x+410, ly0-4, flw_x+440, ly0-4))
    s.append(t(flw_x+448, ly0, "課題=重ねず空きに", 11, MUT))

    # ===== linked selection connector (table row -> flow node top, 左上の帳票を避けて右寄り)
    s.append(f'<path d="M{tbl_x+tbl_w-8},{hl_row_y} C{flw_x-30},{hl_row_y} '
             f'{n1x+108},{n1y-60} {n1x+108},{n1y-2}" fill="none" stroke="{ACC}" '
             f'stroke-width="1.6" stroke-dasharray="5 4" marker-end="url(#arrB)"/>')
    s.append(t(flw_x+8, hl_row_y-6, "リンク選択", 11, ACC, "bold", "middle"))

    # ===== Inspector
    s.append(rect(ins_x, top, ins_w, pane_h, "#ffffff", LINE, rx=8))
    s.append(rect(ins_x, top, ins_w, 34, HDR, LINE, rx=8))
    s.append(t(ins_x+12, top+22, "行インスペクタ", 14, INK, "bold"))
    iy = top + 56
    def field(label, val=None, gap=24):
        nonlocal iy
        s.append(t(ins_x+12, iy, label, 11, MUT, "bold"))
        iy += 16
        if val:
            s.append(t(ins_x+12, iy, val, 12, INK))
            iy += gap
    field("作業名", "注文書受付")
    field("担当", "営業")
    s.append(t(ins_x+12, iy, "インプット", 11, MUT, "bold")); iy += 18
    s.append(chip(ins_x+12, iy-12, 70, 22, BLU, BLU_F, "注文書")); iy += 26
    s.append(t(ins_x+12, iy, "アウトプット", 11, MUT, "bold")); iy += 18
    s.append(chip(ins_x+12, iy-12, 70, 22, GRN, GRN_F, "受付票")); iy += 28
    s.append(t(ins_x+12, iy, "課題 / 方策", 11, MUT, "bold")); iy += 18
    s.append(rect(ins_x+12, iy-12, ins_w-24, 46, RED_F, RED, rx=5));
    s.append(t(ins_x+20, iy+4, "確認漏れ", 11, RED));
    s.append(t(ins_x+20, iy+22, "→ チェックリスト化", 11, INK)); iy += 56
    field("使用システム", "販売管理SYS")
    field("工数", "1.0h（= 子の合計）")
    s.append(t(ins_x+12, iy+6, "（構造化セルは", 10, MUT))
    s.append(t(ins_x+12, iy+20, " ここで追加/編集）", 10, MUT))

    s.append('</svg>')
    return "\n".join(s)


# ============================================================ Wireframe 2: legend
def legend():
    W, H = 1000, 760
    s = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" '
         f'viewBox="0 0 {W} {H}">', DEFS,
         rect(0, 0, W, H, "#ffffff", "#ffffff", rx=0)]
    s.append(t(40, 50, "業務フロー 凡例 / Flow Legend", 24, INK, "bold"))
    s.append(f'<line x1="40" y1="64" x2="{W-40}" y2="64" stroke="{LINE}" stroke-width="1.5"/>')

    # Section 1: objects
    s.append(t(40, 100, "オブジェクト（形＝種類 / 色＝入出力）", 16, INK, "bold"))
    cards = [
        ("工程（タスク）", "task"),
        ("インプット = 青", "in"),
        ("アウトプット = 緑", "out"),
        ("課題", "issue"),
        ("開始 / 終了", "se"),
        ("判断（decision）", "dec"),
        ("合流（merge）", "mrg"),
        ("コメント（付箋）", "cmt"),
    ]
    cw, chh = 222, 130; gx, gy = 40, 120; perrow = 4
    for i, (label, kind) in enumerate(cards):
        cx = gx + (i % perrow) * (cw + 12)
        cy = gy + (i // perrow) * (chh + 14)
        s.append(rect(cx, cy, cw, chh, "#ffffff", LINE, rx=8))
        s.append(t(cx+14, cy+24, label, 12, MUT, "bold"))
        mx, my = cx + cw/2, cy + 78
        if kind == "task":
            s.append(rect(mx-65, my-22, 130, 40, "#ffffff", NODE, rx=6, sw=1.8))
            s.append(t(mx, my+4, "受注確認", 13, INK, "bold", "middle"))
        elif kind == "in":
            s.append(doc(mx-78, my-26, 60, 42, BLU, BLU_F, "帳票"))
            s.append(chip(mx+6, my-16, 64, 26, BLU, BLU_F, "情報"))
        elif kind == "out":
            s.append(doc(mx-78, my-26, 60, 42, GRN, GRN_F, "帳票"))
            s.append(chip(mx+6, my-16, 64, 26, GRN, GRN_F, "情報"))
        elif kind == "issue":
            s.append(rect(mx-32, my-22, 64, 44, RED_F, RED, rx=0, sw=1.8))
            s.append(t(mx, my+5, "課題", 13, RED, "bold", "middle"))
        elif kind == "se":
            s.append(rect(mx-55, my-18, 110, 36, "#ffffff", NODE, rx=18, sw=1.8))
            s.append(t(mx, my+5, "start / end", 12, INK, "normal", "middle"))
        elif kind == "dec":
            s.append(diamond(mx, my, 28))
            s.append(t(mx, my+5, "?", 14, INK, "bold", "middle"))
        elif kind == "mrg":
            s.append(f'<circle cx="{mx}" cy="{my}" r="16" fill="#ffffff" stroke="{NODE}" stroke-width="1.8"/>')
        elif kind == "cmt":
            s.append(rect(mx-50, my-22, 100, 44, YEL_F, YEL, rx=4, sw=1.6))
            s.append(t(mx, my+5, "付箋メモ", 12, YEL, "normal", "middle"))

    # Section 2: connectors
    sy = gy + 2 * (chh + 14) + 24
    s.append(t(40, sy, "コネクタ / 線（矢印は工程間だけ・帳票には引かない）", 16, INK, "bold"))
    rows = [
        ("プロセス矢印（flow）", "工程→工程の流れ・経路解決に影響", "solid"),
        ("課題の線（注釈）", "課題 ↔ 対象（工程 or I/O）・矢頭なし・細く薄い・経路に影響しない", "issue"),
    ]
    ly = sy + 30
    for label, desc, kind in rows:
        x1, x2 = 60, 240
        if kind == "solid":
            s.append(arrow(x1, ly, x2, ly, NODE, sw=2.2))
        elif kind == "issue":
            s.append(pline(x1, ly, x2, ly))
        s.append(t(270, ly+5, label, 14, INK, "bold"))
        s.append(t(470, ly+5, desc, 13, MUT))
        ly += 50
    # I/O rule note
    s.append(doc(70, ly-18, 50, 34, BLU, BLU_F, ""))
    s.append(t(270, ly+5, "帳票/情報は「添える」", 14, INK, "bold"))
    s.append(t(470, ly+5, "線なし・工程の角に重ねる（入力=左上 / 出力=右下）・色で IN/OUT", 13, MUT))
    ly += 44
    s.append(t(60, ly+5, "※ 例外:", 13, INK, "bold"))
    s.append(t(130, ly+5, "フローの起点となる帳票/情報からは、最初の工程へプロセス矢印を引いてよい", 13, MUT))

    s.append('</svg>')
    return "\n".join(s)


for name, svg in [("01-app-shell", shell()), ("02-flow-legend", legend())]:
    p = f"/home/user/gantt-flow/docs/wireframes/{name}"
    with open(p + ".svg", "w") as f:
        f.write(svg)
    cairosvg.svg2png(bytestring=svg.encode(), write_to=p + ".png", scale=1.0)
    print("wrote", p + ".png")
print("done")
