#!/usr/bin/env node
// 日本語技術文書の直訳調マーカーを測定する。
//
// 使い方:
//   node analyze.mjs FILE [FILE...]     ファイルを測定
//   cat doc.md | node analyze.mjs -     標準入力を測定
//   node analyze.mjs --json FILE        JSON で出力(before/after比較用)
//
// Markdown / HTML / プレーンテキストを受け付ける。コードブロック・タグ・
// 表・コマンド行は散文抽出の段階で除外される。
//
// 基準値は 2026-08 の3条件比較実験(書き下ろし条件C / AI翻訳条件B、
// 技術リファレンス題材、各群約1.5万字)に由来する。単位は全て「1万字あたり」。
// 終了コード: 0 = 全項目 ok / 2 = 要修正項目あり
import { readFileSync } from "node:fs";

// 文頭指示語は特別処理(head: true)
const MARKERS = {
  "受動「〜される」": {
    pat: /され(る|ます|た|ている|ない|ず)/g,
    base: 41, trans: 74, warn: 55,
    fix: "動作主を決めて能動に。不要なら「〜とする/〜になる」。※リファレンス文体自体が受動を呼ぶので基準は高め",
  },
  "文頭「これは/この〜は」": {
    head: /^(これ|それ|この[^はがを]{0,12}|本[^はがを]{0,10})[はが]/,
    base: 2.4, trans: 15.8, warn: 6,
    fix: "指す先が直前にあるならほぼ削れる。英語の主語スロットの残骸",
  },
  "モダリティ直訳": {
    pat: /(してもよい|しても構わない|なければならない|なければなりません|すべきで|することが望まし)/g,
    base: 1.8, trans: 4.8, warn: 3,
    fix: "may/must の一対一置換。「〜できる」「〜する」「〜してください」に崩す",
  },
  "複合助詞「において」等": {
    pat: /(において|に関して|について|に対して)/g,
    base: 4.2, trans: 13.0, warn: 7,
    fix: "前置詞の写し。「で」「は」「へ」で足りることが多い",
  },
  "「および/または」": {
    pat: /(および|または|ならびに)/g,
    base: 5.4, trans: 17.8, warn: 9,
    fix: "and/or の写し。日本語の並列は読点だけで成立する",
  },
  "「〜場合」": {
    pat: /場合/g,
    base: 28, trans: 55, warn: 38,
    fix: "if 節の一対一変換。「〜なら」「〜とき」や連体形に散らす",
  },
  "「なお、/ただし、」": {
    pat: /(なお、|ただし、)/g,
    base: 0.5, trans: 5.5, warn: 2.5,
    fix: "Note/However の段落頭写し。文中の「〜が」「〜ため」に畳む",
  },
  "「ことができ」": {
    pat: /ことができ/g,
    base: 0.0, trans: 2.1, warn: 1.0,
    fix: "can の写し。「〜できる」で足りる",
  },
};

// 逆方向マーカー: 少なすぎると翻訳調のシグナル(和文の緩衝装置の欠落)
const SOFTENERS = {
  "「という」": { pat: /という/g, base: 4.9, trans: 0.7 },
};

function extractProse(text) {
  text = text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/<(script|style|svg|pre|code)[^>]*>[\s\S]*?<\/\1>/g, " ")
    .replace(/<[^>]+>/g, "\n")
    .replace(/&[a-z]+;/g, " ")
    .replace(/[ \t\n]+/g, " ");
  const out = [];
  for (let s of text.split("。")) {
    s = s.trim();
    if (!(s.length > 15 && s.length < 300)) continue;
    if (/[\[\]{}|`]/.test(s)) continue; // 表・コマンド書式行
    const kana = (s.match(/[ぁ-ん]/g) || []).length;
    if (kana / s.length < 0.2) continue; // 見出し・コード寄りの行
    out.push(s);
  }
  return out;
}

const count = (s, re) => (s.match(re) || []).length;

function measure(sentences) {
  const n = sentences.reduce((a, s) => a + s.length, 0);
  const res = { chars: n, sentences: sentences.length, markers: {}, softeners: {} };
  if (n === 0) return res;
  const per10k = (v) => Math.round((v * 10000 / n) * 10) / 10;
  for (const [name, m] of Object.entries(MARKERS)) {
    const v = m.head
      ? sentences.filter((s) => m.head.test(s)).length
      : sentences.reduce((a, s) => a + count(s, m.pat), 0);
    const density = per10k(v);
    res.markers[name] = {
      count: v, per10k: density, base: m.base, trans: m.trans,
      flag: density >= m.warn, fix: m.fix,
    };
  }
  for (const [name, m] of Object.entries(SOFTENERS)) {
    const v = sentences.reduce((a, s) => a + count(s, m.pat), 0);
    res.softeners[name] = { count: v, per10k: per10k(v), base: m.base, trans: m.trans };
  }
  const masu = sentences.filter((s) => /(ます|です|ません|ましょう)$/.test(s)).length;
  res.style = { desu_masu: masu, ratio: Math.round((masu / Math.max(sentences.length, 1)) * 100) / 100 };
  return res;
}

function findExamples(sentences, name, limit = 3) {
  const m = MARKERS[name];
  const ex = [];
  for (const s of sentences) {
    const hit = m.head ? m.head.test(s) : new RegExp(m.pat.source).test(s);
    if (hit) {
      ex.push(s.slice(0, 80));
      if (ex.length >= limit) break;
    }
  }
  return ex;
}

// 全角=2/半角=1 の簡易幅で揃える
const width = (s) => [...s].reduce((a, c) => a + (c.codePointAt(0) > 0x2e7f ? 2 : 1), 0);
const pad = (s, w) => s + " ".repeat(Math.max(0, w - width(s)));
const padNum = (v, w) => String(v).padStart(w);

function report(res, sentences) {
  const out = [];
  out.push(`散文 ${res.sentences} 文 / ${res.chars} 字を測定 (数値は1万字あたり)`);
  if (res.chars < 2000) out.push("⚠ 2000字未満: 密度の信頼性は低い。傾向の参考程度に。");
  out.push("");
  out.push(pad("マーカー", 26) + padNum("実測", 6) + padNum("基準", 7) + padNum("翻訳調", 8) + "  判定");
  const flagged = [];
  for (const [name, m] of Object.entries(res.markers)) {
    out.push(pad(name, 26) + padNum(m.per10k, 6) + padNum(m.base, 7) + padNum(m.trans, 8) + (m.flag ? "  ◆ 要修正" : "    ok"));
    if (m.flag) flagged.push(name);
  }
  for (const [name, m] of Object.entries(res.softeners)) {
    const note = m.per10k < 1.5 ? "  ◇ 少ない(断定の連打になっていないか確認)" : "    ok";
    out.push(pad(name + " (緩衝)", 26) + padNum(m.per10k, 6) + padNum(m.base, 7) + padNum(m.trans, 8) + note);
  }
  const r = res.style.ratio;
  if (r > 0.15 && r < 0.85) out.push(`\n⚠ 敬体/常体が混在 (敬体率 ${Math.round(r * 100)}%)。どちらかに統一を。`);
  if (flagged.length) {
    out.push("\n--- 修正ガイドと実例 ---");
    for (const name of flagged) {
      const m = res.markers[name];
      out.push(`\n◆ ${name} (${m.per10k}/万字, 基準 ${m.base})`);
      out.push(`  → ${m.fix}`);
      for (const ex of findExamples(sentences, name)) out.push(`    例: ${ex}`);
    }
    out.push(`\n総合: ${flagged.length} 項目が翻訳調水準。修正順は上の表の並び順が効率的。`);
  } else {
    out.push("\n総合: 翻訳調マーカーはいずれも書き下ろし水準。");
  }
  console.log(out.join("\n"));
  return flagged;
}

// --- main ---
const argv = process.argv.slice(2);
const asJson = argv.includes("--json");
const files = argv.filter((a) => a !== "--json");
if (!files.length) {
  console.log("使い方: node analyze.mjs [--json] FILE [FILE...] | cat doc.md | node analyze.mjs -");
  process.exit(1);
}
const text = files.length === 1 && files[0] === "-"
  ? readFileSync(0, "utf-8")
  : files.map((f) => readFileSync(f, "utf-8")).join("\n");
const sentences = extractProse(text);
const res = measure(sentences);
if (asJson) {
  console.log(JSON.stringify(res, null, 1));
} else {
  process.exit(report(res, sentences).length ? 2 : 0);
}
