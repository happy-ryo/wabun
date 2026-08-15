// analyze.mjs の単体テスト。依存なし: node --test で実行する。
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { extractProse, measure } from "../skills/suiko/scripts/analyze.mjs";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "../skills/suiko/scripts/analyze.mjs");
const run = (...args) => spawnSync("node", [SCRIPT, ...args], { encoding: "utf-8" });

// 15字超・かな率20%以上の散文になるよう下駄を履かせるヘルパ
const doc = (...sentences) => sentences.map((s) => s + "。").join("");

// 翻訳調(閾値以上)・書き下ろし水準の定型文書
const BAD = doc(
  "指定しなかった場合はデフォルト値が使用される場合があります",
  "なお、この場合においてはオプションを指定することができます",
  "ただし、失敗した場合およびタイムアウトした場合は再試行されます"
);
const OK = doc(
  "開始位置を省略すると、findはカレントディレクトリを検索する",
  "評価式を省略したときは-printを実行するという既定の動きになる",
  "検索を速くしたいなら、名前だけで判定できるテストを先に書く"
);

test("固定幅折り返しで泣き別れた語を接合して数える", () => {
  const text = "これは折り返しのある文書とい\n       うものを正しく数えるための検証である。";
  const res = measure(extractProse(text));
  assert.equal(res.softeners["「という」"].count, 1);
});

test("英単語の間の空白は接合しない", () => {
  const text = "このツールは word wrap された文書でも英単語の区切りを保存しながら測定できる。";
  const sentences = extractProse(text);
  assert.ok(sentences[0].includes("word wrap"), `got: ${sentences[0]}`);
});

test("マーカーの計数: 場合・受動・および", () => {
  const text = doc(
    "指定しなかった場合はカレントディレクトリが使用される場合がある",
    "ファイルおよびディレクトリが検査されるが、リンクはたどられない"
  );
  const res = measure(extractProse(text));
  assert.equal(res.markers["「〜場合」"].count, 2);
  assert.equal(res.markers["「および/または」"].count, 1);
  // 仕様: 基準値を測った物差しと同じく「され+終止系」のみ数える。
  // 連用形「検査され、」や五段動詞の受動「たどられない」は対象外
  // (数え方を広げるなら基準値も同じ物差しで測り直すこと)。
  assert.equal(res.markers["受動「〜される」"].count, 2); // 使用される・検査されるが
});

test("文頭指示語は文頭のみ数える", () => {
  const text = doc(
    "これはマニュアルページの冒頭にある典型的な指示語の文である",
    "検索の途中でこれを見つけても文頭ではないので数えない"
  );
  const res = measure(extractProse(text));
  assert.equal(res.markers["文頭「これは/この〜は」"].count, 1);
});

test("文頭指示語: 助詞や引用を飛び越えた後方の「は」を拾わない", () => {
  const text = doc(
    "この修正で「モダリティ硬直は特有」という当初の結論は覆っている",  // 誤検出していた形
    "この標本で AI に偏ったのは受動の多さだったという結果になった",    // 同上
    "この文書には本マニュアルより詳しい説明と議論が含まれている"        // 正当な標的
  );
  const res = measure(extractProse(text));
  assert.equal(res.markers["文頭「これは/この〜は」"].count, 1);
});

test("リスト接頭辞を外して文頭指示語を判定する", () => {
  const text = "- これは箇条書きの中で指示語から始まる一文の検証である。\n";
  const res = measure(extractProse(text));
  assert.equal(res.markers["文頭「これは/この〜は」"].count, 1);
});

test("コードフェンス(```と~~~)と表の行は散文から除外する", () => {
  const text = [
    "```",
    "この場合はコードブロックなので数えられない場合である。",
    "```",
    "~~~",
    "この場合もフェンスの中なので数えない場合である。",
    "~~~",
    "| この場合は表なので数えない場合の行である |",
    doc("散文のこの一文だけが測定の対象になるという想定である"),
  ].join("\n");
  const res = measure(extractProse(text));
  assert.equal(res.sentences, 1);
  assert.equal(res.markers["「〜場合」"].count, 0);
});

test("リンクは表示名を保存し、インラインコードは文を捨てずコードだけ除く", () => {
  const text = doc(
    "詳細は[公式ドキュメント](https://example.com/x)を参照しながら読み進めてほしい",
    "この計測は `find -D help` のようなインラインコードを含む文でも測定の対象になる"
  );
  const sentences = extractProse(text);
  assert.equal(sentences.length, 2, `got: ${JSON.stringify(sentences)}`);
  assert.ok(sentences[0].includes("公式ドキュメント"));
  assert.ok(!sentences[0].includes("https"));
  assert.ok(!sentences[1].includes("find -D help"));
});

test("status の三状態: ok / needs_revision / no_prose", () => {
  assert.equal(measure(extractProse(OK)).status, "ok");
  assert.equal(measure(extractProse(BAD)).status, "needs_revision");
  assert.equal(measure(extractProse("```\ncode only\n```")).status, "no_prose");
});

test("補助判定は warnings に入り status を needs_revision にしない", () => {
  const mixed = doc(
    "敬体と常体の混在を検出する仕組みを確認するための文章です",
    "こちらの一文は常体で書いてあるうえに緩衝表現を置いていない"
  );
  const res = measure(extractProse(mixed));
  assert.equal(res.status, "ok");
  assert.ok(res.warnings.some((w) => w.includes("敬体/常体")), JSON.stringify(res.warnings));
  assert.ok(res.warnings.some((w) => w.includes("という")), JSON.stringify(res.warnings));
});

test("補助判定「詰まり」: 長文・括弧・矢印を warnings で報告し status は変えない", () => {
  const long = "一文をわざと長く書いてあって、" + "とてもとても長い説明が続き、".repeat(8) + "最後まで区切りなく続く";
  const text = doc(
    long,
    "括弧の挿入（一つ目）と（二つ目）を同じ文に置いた検証である",
    "適用の前後で 7 項目 → 0 項目になったという結果を矢印で書いてある"
  );
  const res = measure(extractProse(text));
  assert.equal(res.status, "ok");
  assert.equal(res.density["長文(120字以上)"].count, 1);
  assert.equal(res.density["括弧の挿入が2回以上ある文"].count, 1);
  assert.equal(res.density["散文中の矢印記号"].count, 1);
  assert.ok(res.warnings.filter((w) => w.startsWith("詰まり:")).length === 3, JSON.stringify(res.warnings));
});

test("CLI: 終了コード 2(要修正) / 0(水準内) / 1(散文なし) / 64(引数なし)", () => {
  const dir = mkdtempSync(join(tmpdir(), "wabun-test-"));
  const bad = join(dir, "bad.txt"); writeFileSync(bad, BAD);
  const ok = join(dir, "ok.txt"); writeFileSync(ok, OK);
  const empty = join(dir, "empty.txt"); writeFileSync(empty, "```\nonly code\n```\n");
  assert.equal(run(bad).status, 2);
  assert.equal(run(ok).status, 0);
  assert.equal(run(empty).status, 1);
  assert.equal(run().status, 64);
});

test("CLI: 複数ファイルは個別測定、1つでも閾値以上なら exit 2", () => {
  const dir = mkdtempSync(join(tmpdir(), "wabun-test-"));
  const bad = join(dir, "bad.txt"); writeFileSync(bad, BAD);
  const ok = join(dir, "ok.txt"); writeFileSync(ok, OK);
  const r = run(ok, bad);
  assert.equal(r.status, 2);
  assert.ok(r.stdout.includes("━━")); // ファイル別のラベル表示
  const j = JSON.parse(run("--json", ok, bad).stdout);
  assert.equal(j.files.length, 2);
  assert.equal(j.files[0].status, "ok");
  assert.equal(j.files[1].status, "needs_revision");
});

test("CLI: --aggregate は連結測定して aggregate を返す", () => {
  const dir = mkdtempSync(join(tmpdir(), "wabun-test-"));
  const a = join(dir, "a.txt"); writeFileSync(a, OK);
  const b = join(dir, "b.txt"); writeFileSync(b, OK);
  const j = JSON.parse(run("--json", "--aggregate", a, b).stdout);
  assert.ok(j.aggregate);
  assert.equal(j.aggregate.status, "ok");
  assert.ok(j.aggregate.chars > measure(extractProse(OK)).chars);
});

test("softener は同ジャンル基準と一般書き下ろしの両方を持つ", () => {
  const res = measure(extractProse(OK));
  const s = res.softeners["「という」"];
  assert.ok("reference" in s && "general" in s && "translation" in s);
});

test("CLI: 大量ファイルの --json が途中で切れない (64KB超)", () => {
  const dir = mkdtempSync(join(tmpdir(), "wabun-test-"));
  const files = [];
  for (let i = 0; i < 50; i++) {
    const f = join(dir, `doc${i}.txt`);
    writeFileSync(f, OK.repeat(4));
    files.push(f);
  }
  const r = run("--json", ...files);
  assert.ok(r.stdout.length > 65536, `出力が小さすぎて回帰確認にならない: ${r.stdout.length}`);
  const j = JSON.parse(r.stdout); // exit() 直切りだとここで途切れて落ちる
  assert.equal(j.files.length, 50);
});

test("CLI: ok と no_prose の混在は exit 1 (部分失敗を成功にしない)", () => {
  const dir = mkdtempSync(join(tmpdir(), "wabun-test-"));
  const ok = join(dir, "ok.txt"); writeFileSync(ok, OK);
  const np = join(dir, "np.txt"); writeFileSync(np, "```\ncode only\n```\n");
  assert.equal(run(ok, np).status, 1);
  // needs_revision が混じれば 2 が優先
  const bad = join(dir, "bad.txt"); writeFileSync(bad, BAD);
  assert.equal(run(ok, np, bad).status, 2);
});

test("CLI: --aggregate は未閉鎖フェンスが後続ファイルを汚染しない", () => {
  const dir = mkdtempSync(join(tmpdir(), "wabun-test-"));
  const a = join(dir, "a.txt"); writeFileSync(a, "```\n閉じていないフェンスの中身\n");
  const b = join(dir, "b.txt"); writeFileSync(b, OK);
  const j = JSON.parse(run("--json", "--aggregate", a, b).stdout);
  assert.ok(j.aggregate.chars > 0, "b.txt の散文が測定されていない");
  assert.equal(j.aggregate.status, "ok");
});

test("CLI: 入力エラーは 66、不明オプションは 64", () => {
  assert.equal(run("/no/such/file.txt").status, 66);
  assert.equal(run("--bogus", "x.txt").status, 64);
});

test("引用内フェンス(> ```)のコードを数えない", () => {
  const text = [
    "> ```",
    "> この場合はコードなので数えない場合である。",
    "> ```",
    doc("散文のこの一文だけを測定するという想定で書いてある"),
  ].join("\n");
  const res = measure(extractProse(text));
  assert.equal(res.markers["「〜場合」"].count, 0);
  assert.equal(res.sentences, 1);
});

test("4連フェンスを内側の3連で閉じた扱いにしない", () => {
  const text = [
    "````",
    "```",
    "この場合はまだフェンスの中なので数えない場合である。",
    "````",
    doc("散文のこの一文だけを測定するという想定で書いてある"),
  ].join("\n");
  const res = measure(extractProse(text));
  assert.equal(res.markers["「〜場合」"].count, 0);
  assert.equal(res.sentences, 1);
});

test("複数バッククォートのコードスパンを数えない", () => {
  const text = doc("この検証は ``失敗した場合`` というコードスパンを含む文でも中身を数えない");
  const res = measure(extractProse(text));
  assert.equal(res.markers["「〜場合」"].count, 0);
  assert.equal(res.sentences, 1);
});

test("先頭 | のない GFM 表をブロックで除外する", () => {
  const text = [
    "列の見出しA | 列の見出しB",
    "--- | ---",
    "この場合は表の中の行である | 数えない場合の値",
    doc("散文のこの一文だけを測定するという想定で書いてある"),
  ].join("\n");
  const res = measure(extractProse(text));
  assert.equal(res.markers["「〜場合」"].count, 0);
  assert.equal(res.sentences, 1);
});

test("句点のない箇条書きが融合して300字超過で捨てられない", () => {
  const items = Array.from({ length: 20 }, (_, i) =>
    `- 箇条書きの項目その${i}は句点を持たないまま並んでいる`);
  const res = measure(extractProse(items.join("\n")));
  assert.equal(res.sentences, 20, `sentences=${res.sentences}`);
});

test("引用内リスト(> - これは…)の文頭指示語を検出する", () => {
  const text = "> - これは引用の中の箇条書きで指示語から始まる一文である。\n";
  const res = measure(extractProse(text));
  assert.equal(res.markers["文頭「これは/この〜は」"].count, 1);
});
