#!/usr/bin/env node
// 日本語技術文書の直訳調マーカーを測定する。
//
// 使い方:
//   node analyze.mjs FILE [FILE...]        ファイルごとに測定(既定)
//   node analyze.mjs --aggregate FILE...   全ファイルを連結して測定(コーパス用)
//   cat doc.md | node analyze.mjs -        標準入力を測定
//   node analyze.mjs --json FILE           JSON で出力(before/after比較用)
//
// Markdown / HTML / プレーンテキストを受け付ける。コードフェンス・タグ・
// 表・インラインコードは除去し、リンクは表示名を、リスト/引用/見出しは
// 接頭辞を外した本文を散文として保存する。
//
// 基準値は 2026-08 の3条件比較実験(書き下ろし条件C / AI翻訳条件B、
// 技術リファレンス題材、各群約1.5万字)のコーパスを、このスクリプトの
// 現行版で測定した値。単位は全て「1万字あたり」。
//
// 終了コード:
//   0 = ok(主要マーカーは書き下ろし水準)
//   1 = no_prose(測定可能な散文がない)
//   2 = needs_revision(主要マーカーが閾値超過。複数ファイル時は1つでも超過で2)
//  64 = 引数エラー
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

// 文頭指示語は特別処理(head: true)
export const MARKERS = {
  "受動「〜される」": {
    pat: /され(る|ます|た|ている|ない|ず)/g,
    base: 41.5, trans: 79.1, warn: 55,
    fix: "動作主が原文か文脈から一意に決まる場合だけ能動に。決まらなければ「〜とする/〜になる」等の非受動を検討し、不自然なら残す。※リファレンス文体自体が受動を呼ぶので基準は高め",
  },
  "文頭「これは/この〜は」": {
    head: /^(これ|それ|この[^はがを]{0,12}|本[^はがを]{0,10})[はが]/,
    base: 3.0, trans: 15.5, warn: 6,
    fix: "指す先が直前にあるならほぼ削れる。英語の主語スロットの残骸",
  },
  "モダリティ直訳": {
    pat: /(してもよい|しても構わない|なければならない|なければなりません|すべきで|することが望まし)/g,
    base: 1.8, trans: 6.4, warn: 3,
    fix: "意味で訳し分ける。許可は「〜してよい/〜を認める」、義務は「〜が必要だ/〜を必須とする」、推奨は「〜を推奨する」。「〜できる」に崩してよいのは能力の意味のときだけ",
  },
  "複合助詞「において」等": {
    pat: /(において|に関して|について|に対して)/g,
    base: 4.2, trans: 14.1, warn: 7,
    fix: "前置詞の写し。「で」「は」「へ」で足りることが多い",
  },
  "「および/または」": {
    pat: /(および|または|ならびに)/g,
    base: 5.4, trans: 18.4, warn: 9,
    fix: "論理関係を保って言い換える。「および」は「と/両方」、「または」は「か/いずれか」。AND か OR か判別できないなら変更しない",
  },
  "「〜場合」": {
    pat: /場合/g,
    base: 28.8, trans: 57.9, warn: 38,
    fix: "if 節の一対一変換。「〜なら」「〜とき」や連体形に散らす",
  },
  "「なお、/ただし、」": {
    pat: /(なお、|ただし、)/g,
    base: 0.0, trans: 5.6, warn: 2.5,
    fix: "Note/However の段落頭写し。文中の「〜が」「〜ため」に畳む",
  },
  "「ことができ」": {
    pat: /ことができ/g,
    base: 0.0, trans: 2.1, warn: 1.0,
    fix: "can の写し。「〜できる」で足りる",
  },
};

// 逆方向マーカー: 少なすぎると翻訳調のシグナル(和文の緩衝装置の欠落)。
// reference = 同ジャンル書き下ろし(C)、general = 別題材の一般書き下ろし(A)、
// translation = AI翻訳(B)。リファレンス文体自体が緩衝を減らすため両方持つ。
export const SOFTENERS = {
  "「という」": { pat: /という/g, reference: 1.8, general: 5.0, translation: 0.7, warnBelow: 1.5 },
};

export function extractProse(text) {
  text = text.replace(/\r\n?/g, "\n");
  // コードフェンス(``` / ~~~)は行単位の状態機械で除外する
  const kept = [];
  let fence = null;
  for (const line of text.split("\n")) {
    const m = line.match(/^[ \t]*(`{3,}|~{3,})/);
    if (fence) {
      if (m && m[1][0] === fence) fence = null;
      continue;
    }
    if (m) { fence = m[1][0]; continue; }
    kept.push(line);
  }
  text = kept
    .join("\n")
    .replace(/<(script|style|svg|pre|code)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, "\n")
    // markdown の表の行は行単位で除去する(改行を潰した後だと隣の散文と
    // 同じ断片に融合するため)
    .replace(/^[ \t]*\|.*$/gm, " ")
    // リンク・画像は表示名を散文として保存する
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    // インラインコードはコード部分だけ空白にする(文は捨てない)
    .replace(/`[^`\n]*`/g, " ")
    // リスト・引用・見出しの接頭辞を外してから文頭判定に回す
    .replace(/^[ \t]*(?:[-*+]|\d+[.)]|>+|#{1,6})[ \t]+/gm, "")
    .replace(/&[a-z]+;/gi, " ")
    .replace(/[ \t\n]+/g, " ")
    // 固定幅折り返しで泣き別れた語を接合する:
    // 日本語文字(かな・カナ・漢字・全角記号)同士に挟まれた空白は行折り返し由来
    // とみなして除去する。英単語間の空白は保持される。
    .replace(/([、-ヿ㐀-鿿！-｠])[ ]+(?=[、-ヿ㐀-鿿！-｠])/g, "$1");
  const out = [];
  for (let s of text.split("。")) {
    s = s.trim();
    if (!(s.length > 15 && s.length < 300)) continue;
    const kana = (s.match(/[ぁ-ん]/g) || []).length;
    if (kana / s.length < 0.2) continue; // 見出し・コード寄りの行
    out.push(s);
  }
  return out;
}

const count = (s, re) => (s.match(re) || []).length;

export function measure(sentences) {
  const n = sentences.reduce((a, s) => a + s.length, 0);
  const res = {
    chars: n, sentences: sentences.length,
    status: "no_prose", markers: {}, softeners: {}, warnings: [],
    style: { desu_masu: 0, ratio: 0 },
  };
  if (n === 0) return res;
  const per10k = (v) => Math.round((v * 10000 / n) * 10) / 10;
  const flagged = [];
  for (const [name, m] of Object.entries(MARKERS)) {
    const v = m.head
      ? sentences.filter((s) => m.head.test(s)).length
      : sentences.reduce((a, s) => a + count(s, m.pat), 0);
    const density = per10k(v);
    const flag = density >= m.warn;
    if (flag) flagged.push(name);
    res.markers[name] = { count: v, per10k: density, base: m.base, trans: m.trans, flag, fix: m.fix };
  }
  for (const [name, m] of Object.entries(SOFTENERS)) {
    const v = sentences.reduce((a, s) => a + count(s, m.pat), 0);
    const density = per10k(v);
    const low = density < m.warnBelow;
    res.softeners[name] = {
      count: v, per10k: density,
      reference: m.reference, general: m.general, translation: m.translation, low,
    };
    if (low) res.warnings.push(`${name}が少ない(同ジャンル基準 ${m.reference}、別題材の一般書き下ろしでは ${m.general})。断定の連打になっていないか確認`);
  }
  const masu = sentences.filter((s) => /(ます|です|ません|ましょう)$/.test(s)).length;
  const ratio = Math.round((masu / sentences.length) * 100) / 100;
  res.style = { desu_masu: masu, ratio };
  if (ratio > 0.15 && ratio < 0.85) res.warnings.push(`敬体/常体が混在(敬体率 ${Math.round(ratio * 100)}%)。どちらかに統一を`);
  if (n < 2000) res.warnings.push("散文 2000 字未満: 密度の信頼性は低い。傾向の参考程度に");
  res.status = flagged.length ? "needs_revision" : "ok";
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

function report(res, sentences, label) {
  const out = [];
  if (label) out.push(`━━ ${label}`);
  if (res.status === "no_prose") {
    out.push("測定可能な散文がありません(コード・表・英文のみ、または短すぎる)。");
    console.log(out.join("\n"));
    return;
  }
  out.push(`散文 ${res.sentences} 文 / ${res.chars} 字を測定 (数値は1万字あたり)`);
  out.push("");
  out.push(pad("マーカー", 26) + padNum("実測", 6) + padNum("基準", 7) + padNum("翻訳調", 8) + "  判定");
  const flagged = [];
  for (const [name, m] of Object.entries(res.markers)) {
    out.push(pad(name, 26) + padNum(m.per10k, 6) + padNum(m.base, 7) + padNum(m.trans, 8) + (m.flag ? "  ◆ 要修正" : "    ok"));
    if (m.flag) flagged.push(name);
  }
  for (const [name, m] of Object.entries(res.softeners)) {
    out.push(pad(name + " (緩衝)", 26) + padNum(m.per10k, 6) + padNum(m.reference, 7) + padNum(m.translation, 8) + (m.low ? "  ◇ 少ない" : "    ok"));
  }
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
    out.push("\n総合: 主要な翻訳調マーカーは書き下ろし水準。");
  }
  // 補助判定は主要マーカーと分けて報告する(失敗扱いにしない)
  for (const w of res.warnings) out.push(`補助判定: ${w}`);
  console.log(out.join("\n"));
}

// --- main (CLI 実行時のみ。テストからの import では走らない) ---
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const argv = process.argv.slice(2);
  const asJson = argv.includes("--json");
  const aggregate = argv.includes("--aggregate");
  const files = argv.filter((a) => a !== "--json" && a !== "--aggregate");
  if (!files.length) {
    console.log("使い方: node analyze.mjs [--json] [--aggregate] FILE [FILE...] | cat doc.md | node analyze.mjs -");
    process.exit(64);
  }
  const readOne = (f) => (f === "-" ? readFileSync(0, "utf-8") : readFileSync(f, "utf-8"));
  const results = [];
  let agg = null;
  if (aggregate) {
    const sentences = extractProse(files.map(readOne).join("\n"));
    agg = { ...measure(sentences), files: files.slice() };
    if (!asJson) report(agg, sentences, `連結測定 (${files.length} ファイル)`);
  } else {
    for (const f of files) {
      const sentences = extractProse(readOne(f));
      const res = measure(sentences);
      results.push({ file: f, res, sentences });
      if (!asJson) {
        report(res, sentences, files.length > 1 ? f : undefined);
        if (files.length > 1) console.log("");
      }
    }
  }
  if (asJson) {
    const payload = aggregate
      ? { files: files.slice(), aggregate: agg }
      : { files: results.map(({ file, res }) => ({ file, ...res })) };
    console.log(JSON.stringify(payload, null, 1));
  }
  const statuses = aggregate ? [agg.status] : results.map((r) => r.res.status);
  if (statuses.includes("needs_revision")) process.exit(2);
  if (statuses.every((s) => s === "no_prose")) process.exit(1);
  process.exit(0);
}
