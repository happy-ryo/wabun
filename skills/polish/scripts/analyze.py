#!/usr/bin/env python3
"""日本語技術文書の直訳調マーカーを測定する。

使い方:
    python3 analyze.py FILE [FILE...]        # ファイルを測定
    cat doc.md | python3 analyze.py -        # 標準入力を測定
    python3 analyze.py --json FILE           # JSON で出力(before/after比較用)

Markdown / HTML / プレーンテキストを受け付ける。コードブロック・タグ・
表・コマンド行は散文抽出の段階で除外される。

基準値は 2026-08 の3条件比較実験(書き下ろし条件C / AI翻訳条件B、
技術リファレンス題材、各群約1.5万字)に由来する。単位は全て「1万字あたり」。
"""
import sys, re, json, unicodedata

# (パターン, 書き下ろし基準C, 翻訳調水準B, 警告閾値, 修正ガイド)
MARKERS = {
    "受動「〜される」": {
        "pat": r"され(る|ます|た|ている|ない|ず)",
        "base": 41, "trans": 74, "warn": 55,
        "fix": "動作主を決めて能動に。不要なら「〜とする/〜になる」。※リファレンス文体自体が受動を呼ぶので基準は高め",
    },
    "文頭「これは/この〜は」": {
        "pat": None,  # 文頭マッチ(特別処理)
        "base": 2.4, "trans": 15.8, "warn": 6,
        "fix": "指す先が直前にあるならほぼ削れる。英語の主語スロットの残骸",
    },
    "モダリティ直訳": {
        "pat": r"(してもよい|しても構わない|なければならない|なければなりません|すべきで|することが望まし)",
        "base": 1.8, "trans": 4.8, "warn": 3,
        "fix": "may/must の一対一置換。「〜できる」「〜する」「〜してください」に崩す",
    },
    "複合助詞「において」等": {
        "pat": r"(において|に関して|について|に対して)",
        "base": 4.2, "trans": 13.0, "warn": 7,
        "fix": "前置詞の写し。「で」「は」「へ」で足りることが多い",
    },
    "「および/または」": {
        "pat": r"(および|または|ならびに)",
        "base": 5.4, "trans": 17.8, "warn": 9,
        "fix": "and/or の写し。日本語の並列は読点だけで成立する",
    },
    "「〜場合」": {
        "pat": r"場合",
        "base": 28, "trans": 55, "warn": 38,
        "fix": "if 節の一対一変換。「〜なら」「〜とき」や連体形に散らす",
    },
    "「なお、/ただし、」": {
        "pat": r"(なお、|ただし、)",
        "base": 0.5, "trans": 5.5, "warn": 2.5,
        "fix": "Note/However の段落頭写し。文中の「〜が」「〜ため」に畳む",
    },
    "「ことができ」": {
        "pat": r"ことができ",
        "base": 0.0, "trans": 2.1, "warn": 1.0,
        "fix": "can の写し。「〜できる」で足りる",
    },
}

# 逆方向マーカー: 少なすぎると翻訳調のシグナル(和文の緩衝装置の欠落)
SOFTENERS = {
    "「という」": {"pat": r"という", "base": 4.9, "trans": 0.7},
}


def extract_prose(text: str):
    """散文の文リストを返す。コード・表・タグ・コマンド行を除外する。"""
    # コードブロック除去 (markdown fence / html pre,code,script,style,svg)
    text = re.sub(r"```.*?```", " ", text, flags=re.S)
    text = re.sub(r"<(script|style|svg|pre|code)[^>]*>.*?</\1>", " ", text, flags=re.S)
    text = re.sub(r"<[^>]+>", "\n", text)
    text = re.sub(r"&[a-z]+;", " ", text)
    text = re.sub(r"[ \t\n]+", " ", text)
    out = []
    for s in text.split("。"):
        s = s.strip()
        if not (15 < len(s) < 300):
            continue
        if re.search(r"[\[\]{}|`]", s):  # 表・コマンド書式行
            continue
        kana = len(re.findall(r"[ぁ-ん]", s))
        if kana / len(s) < 0.20:  # 見出し・コード寄りの行
            continue
        out.append(s)
    return out


def measure(sentences):
    n = sum(len(s) for s in sentences)
    res = {"chars": n, "sentences": len(sentences), "markers": {}, "softeners": {}}
    if n == 0:
        return res
    for name, m in MARKERS.items():
        if name == "文頭「これは/この〜は」":
            v = sum(1 for s in sentences
                    if re.match(r"(これ|それ|この[^はがを]{0,12}|本[^はがを]{0,10})[はが]", s))
        else:
            v = sum(len(re.findall(m["pat"], s)) for s in sentences)
        density = round(v * 10000 / n, 1)
        res["markers"][name] = {
            "count": v, "per10k": density,
            "base": m["base"], "trans": m["trans"],
            "flag": density >= m["warn"], "fix": m["fix"],
        }
    for name, m in SOFTENERS.items():
        v = sum(len(re.findall(m["pat"], s)) for s in sentences)
        res["softeners"][name] = {"count": v, "per10k": round(v * 10000 / n, 1),
                                  "base": m["base"], "trans": m["trans"]}
    # 文末の敬体/常体の混在チェック
    masu = sum(1 for s in sentences if re.search(r"(ます|です|ません|ましょう)$", s))
    res["style"] = {"desu_masu": masu, "ratio": round(masu / max(len(sentences), 1), 2)}
    return res


def find_examples(sentences, name, limit=3):
    m = MARKERS.get(name)
    ex = []
    for s in sentences:
        if name == "文頭「これは/この〜は」":
            hit = re.match(r"(これ|それ|この[^はがを]{0,12}|本[^はがを]{0,10})[はが]", s)
        else:
            hit = re.search(m["pat"], s)
        if hit:
            ex.append(s[:80])
            if len(ex) >= limit:
                break
    return ex


def width(s):
    return sum(2 if unicodedata.east_asian_width(c) in "WF" else 1 for c in s)


def pad(s, w):
    return s + " " * max(0, w - width(s))


def report(res, sentences):
    print(f"散文 {res['sentences']} 文 / {res['chars']} 字を測定 (数値は1万字あたり)")
    if res["chars"] < 2000:
        print("⚠ 2000字未満: 密度の信頼性は低い。傾向の参考程度に。")
    print()
    print(pad("マーカー", 26) + f"{'実測':>6} {'基準':>6} {'翻訳調':>7}  判定")
    flagged = []
    for name, m in res["markers"].items():
        mark = "◆ 要修正" if m["flag"] else "  ok"
        print(pad(name, 26) + f"{m['per10k']:>6} {m['base']:>6} {m['trans']:>7}  {mark}")
        if m["flag"]:
            flagged.append(name)
    for name, m in res["softeners"].items():
        note = "◇ 少ない(断定の連打になっていないか確認)" if m["per10k"] < 1.5 else "  ok"
        print(pad(name + " (緩衝)", 26) + f"{m['per10k']:>6} {m['base']:>6} {m['trans']:>7}  {note}")
    r = res["style"]["ratio"]
    if 0.15 < r < 0.85:
        print(f"\n⚠ 敬体/常体が混在 (敬体率 {r:.0%})。どちらかに統一を。")
    if flagged:
        print("\n--- 修正ガイドと実例 ---")
        for name in flagged:
            m = res["markers"][name]
            print(f"\n◆ {name} ({m['per10k']}/万字, 基準 {m['base']})")
            print(f"  → {m['fix']}")
            for ex in find_examples(sentences, name):
                print(f"    例: {ex}")
        print(f"\n総合: {len(flagged)} 項目が翻訳調水準。修正順は上の表の並び順が効率的。")
    else:
        print("\n総合: 翻訳調マーカーはいずれも書き下ろし水準。")
    return flagged


def main():
    args = [a for a in sys.argv[1:] if a != "--json"]
    as_json = "--json" in sys.argv
    if not args:
        print(__doc__)
        sys.exit(1)
    if args == ["-"]:
        text = sys.stdin.read()
    else:
        text = ""
        for f in args:
            with open(f, encoding="utf-8", errors="replace") as fh:
                text += fh.read() + "\n"
    sentences = extract_prose(text)
    res = measure(sentences)
    if as_json:
        print(json.dumps(res, ensure_ascii=False, indent=1))
    else:
        flagged = report(res, sentences)
        sys.exit(2 if flagged else 0)


if __name__ == "__main__":
    main()
