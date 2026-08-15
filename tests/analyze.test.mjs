// analyze.mjs の単体テスト。依存なし: node --test tests/ で実行する。
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { extractProse, measure } from "../skills/suiko/scripts/analyze.mjs";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "../skills/suiko/scripts/analyze.mjs");

// 15字超・かな率20%以上の散文になるよう下駄を履かせるヘルパ
const doc = (...sentences) => sentences.map((s) => s + "。").join("");

test("固定幅折り返しで泣き別れた語を接合して数える", () => {
  // man ページ風に「という」が行またぎで泣き別れているケース
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

test("コードブロックと表の行は散文から除外する", () => {
  const text = [
    "```",
    "この場合はコードブロックなので数えられない場合である。",
    "```",
    "| この場合は表なので数えない場合の行である。 |",
    doc("散文のこの一文だけが測定の対象になるという想定である"),
  ].join("\n");
  const res = measure(extractProse(text));
  assert.equal(res.sentences, 1);
  assert.equal(res.markers["「〜場合」"].count, 0);
});

test("敬体率を報告する", () => {
  const text = doc(
    "この文書は敬体で書かれた文章の比率を確認するためのものです",
    "こちらの一文は常体で書いてあるので敬体には数えない"
  );
  const res = measure(extractProse(text));
  assert.equal(res.style.desu_masu, 1);
  assert.equal(res.style.ratio, 0.5);
});

test("CLI: 翻訳調文書は exit 2、書き下ろし水準は exit 0", () => {
  const dir = mkdtempSync(join(tmpdir(), "wabun-test-"));
  // 翻訳調: 「場合」「なお、」「ことができ」を高密度で含む短文集
  const bad = join(dir, "bad.txt");
  writeFileSync(bad, doc(
    "指定しなかった場合はデフォルト値が使用される場合があります",
    "なお、この場合においてはオプションを指定することができます",
    "ただし、失敗した場合およびタイムアウトした場合は再試行されます"
  ));
  const ok = join(dir, "ok.txt");
  writeFileSync(ok, doc(
    "開始位置を省略すると、findはカレントディレクトリを検索する",
    "評価式を省略したときは-printを実行するという既定の動きになる",
    "検索を速くしたいなら、名前だけで判定できるテストを先に書く"
  ));
  assert.equal(spawnSync("node", [SCRIPT, bad], { encoding: "utf-8" }).status, 2);
  assert.equal(spawnSync("node", [SCRIPT, ok], { encoding: "utf-8" }).status, 0);
});

test("CLI: --json は機械可読な結果を返す", () => {
  const dir = mkdtempSync(join(tmpdir(), "wabun-test-"));
  const f = join(dir, "doc.txt");
  writeFileSync(f, doc("JSON出力の形式を確認するための十分に長い一文をここに置いておく"));
  const out = spawnSync("node", [SCRIPT, "--json", f], { encoding: "utf-8" });
  const res = JSON.parse(out.stdout);
  assert.ok(res.chars > 0);
  assert.ok("markers" in res && "softeners" in res && "style" in res);
});
