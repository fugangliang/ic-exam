/* logic.js の単体テスト。実行: node scripts/test_logic.js */
const Logic = require("../app/logic.js");
const assert = require("node:assert");

const q = (id, cat, sub, extra = {}) => ({
  id, category: cat, subcategory: sub, source: "test",
  body: "本文", choices: ["a", "b", "c", "d"], answer: 0,
  explanation: "解説", has_figure: false, ...extra,
});

// validateQuestion
assert.deepStrictEqual(Logic.validateQuestion(q("1", "法規", "建基法")), []);
assert.ok(Logic.validateQuestion({}).length > 0);
assert.ok(Logic.validateQuestion(q("1", "法規", "s", { answer: 4 })).some(e => e.includes("answer")));
assert.ok(Logic.validateQuestion(q("1", "法規", "s", { choices: ["only"] })).some(e => e.includes("choices")));
assert.ok(Logic.validateQuestion(q("", "法規", "s")).some(e => e.includes("id")));

// normalizeImport: 配列形式
let r = Logic.normalizeImport([q("1", "A", "x"), q("2", "B", "y")]);
assert.strictEqual(r.questions.length, 2);
assert.strictEqual(r.attempts, null);
assert.strictEqual(r.errors.length, 0);

// normalizeImport: id重複はスキップ
r = Logic.normalizeImport([q("1", "A", "x"), q("1", "A", "x")]);
assert.strictEqual(r.questions.length, 1);
assert.strictEqual(r.errors.length, 1);

// normalizeImport: {questions, attempts} フルバックアップ形式
r = Logic.normalizeImport({ questions: [q("1", "A", "x")], attempts: [{ question_id: "1", timestamp: 1, correct: true, time_sec: 5, confidence: "sure" }] });
assert.strictEqual(r.questions.length, 1);
assert.strictEqual(r.attempts.length, 1);

// normalizeImport: 不正形式
r = Logic.normalizeImport("garbage");
assert.strictEqual(r.questions.length, 0);
assert.ok(r.errors.length > 0);

// buildQuizSet: 図版除外・分野/小分類フィルタ・件数制限
const pool = [
  q("1", "法規", "建基法"), q("2", "法規", "消防法"),
  q("3", "歴史", "様式"), q("4", "法規", "建基法", { has_figure: true }),
];
const rng = () => 0.5;
assert.strictEqual(Logic.buildQuizSet(pool, { mode: "random", count: 0 }, rng).length, 3); // 画像なしの図版問題は除外
assert.strictEqual(Logic.buildQuizSet(pool, { mode: "category", category: "法規", subcategory: "", count: 0 }, rng).length, 2);
assert.strictEqual(Logic.buildQuizSet(pool, { mode: "category", category: "法規", subcategory: "建基法", count: 0 }, rng).length, 1);
assert.strictEqual(Logic.buildQuizSet(pool, { mode: "random", count: 2 }, rng).length, 2);

// shuffle: 元配列を破壊しない・要素保存
const orig = [1, 2, 3, 4, 5];
const shuffled = Logic.shuffle(orig);
assert.deepStrictEqual(orig, [1, 2, 3, 4, 5]);
assert.deepStrictEqual(shuffled.slice().sort(), [1, 2, 3, 4, 5]);

// categoryTree
const tree = Logic.categoryTree(pool);
assert.deepStrictEqual([...tree.get("法規")], ["建基法", "消防法"]);

// summarize
const byId = new Map(pool.map(x => [x.id, x]));
const s = Logic.summarize([
  { question_id: "1", correct: true, time_sec: 10 },
  { question_id: "2", correct: false, time_sec: 20 },
  { question_id: "3", correct: true, time_sec: 30 },
], byId);
assert.strictEqual(s.total, 3);
assert.strictEqual(s.correct, 2);
assert.strictEqual(s.byCat.get("法規").total, 2);
assert.strictEqual(s.byCat.get("法規").correct, 1);

// overallStats
const now = Date.now();
const st = Logic.overallStats([
  { correct: true, timestamp: now },
  { correct: false, timestamp: now - 86400000 * 3 },
]);
assert.strictEqual(st.total, 2);
assert.strictEqual(st.rate, 50);
assert.strictEqual(st.todayCount, 1);

// perQuestionStats: 全履歴を蓄積し、最新の解答（timestamp最大）を lastCorrect/lastConfidence に反映
const pq = Logic.perQuestionStats([
  { question_id: "1", correct: true, timestamp: 100, confidence: "sure" },
  { question_id: "1", correct: false, timestamp: 200, confidence: "guess" },
  { question_id: "2", correct: true, timestamp: 150, confidence: "unsure" },
]);
assert.strictEqual(pq.get("1").times, 2);
assert.strictEqual(pq.get("1").correctCount, 1);
assert.strictEqual(pq.get("1").wrongCount, 1);
assert.strictEqual(pq.get("1").lastCorrect, false);
assert.strictEqual(pq.get("1").lastConfidence, "guess");
assert.strictEqual(pq.get("2").lastCorrect, true);
assert.strictEqual(pq.get("3"), undefined);

// categoryStats: 分野別に全履歴の正答率と「直近不正解」件数を集計し、苦手（wrongNow多い）順に並べる
const csPool = [q("1", "法規", "建基法"), q("2", "法規", "消防法"), q("3", "歴史", "様式")];
const cs = Logic.categoryStats(csPool, [
  { question_id: "1", correct: false, timestamp: 1, confidence: "guess" },
  { question_id: "1", correct: false, timestamp: 2, confidence: "guess" },
  { question_id: "2", correct: true, timestamp: 1, confidence: "sure" },
]);
const lawStats = cs.find(c => c.category === "法規");
assert.strictEqual(lawStats.totalQuestions, 2);
assert.strictEqual(lawStats.attemptedQuestions, 2);
assert.strictEqual(lawStats.wrongNow, 1);
assert.strictEqual(lawStats.accuracy, 33);
const historyStats = cs.find(c => c.category === "歴史");
assert.strictEqual(historyStats.attemptedQuestions, 0);
assert.strictEqual(historyStats.accuracy, null);
assert.strictEqual(cs[0].category, "法規"); // wrongNowが多い分野が先頭

// buildQuizSet: onlyWrong/onlyUnsure で直近解答に基づき抽出（未解答は対象外）
const qStats = Logic.perQuestionStats([
  { question_id: "1", correct: false, timestamp: 1, confidence: "guess" },
  { question_id: "2", correct: true, timestamp: 1, confidence: "sure" },
  { question_id: "3", correct: true, timestamp: 1, confidence: "unsure" },
]);
const wrongSet = Logic.buildQuizSet(pool, { mode: "random", count: 0, onlyWrong: true, questionStats: qStats }, rng);
assert.strictEqual(wrongSet.length, 1);
assert.strictEqual(wrongSet[0].id, "1");
// onlyUnsure は「迷い・勘で正解」のみ（id3）。勘で不正解の id1 は「直近不正解」側に入る（状態は1つに決める・2026-10-11）
const unsureSet = Logic.buildQuizSet(pool, { mode: "random", count: 0, onlyUnsure: true, questionStats: qStats }, rng);
assert.strictEqual(unsureSet.length, 1);
assert.deepStrictEqual(unsureSet.map(q => q.id), ["3"]);
const noneSet = Logic.buildQuizSet(pool, { mode: "random", count: 0, onlyWrong: true, onlyUnsure: true, questionStats: new Map() }, rng);
assert.strictEqual(noneSet.length, 0); // 統計が空なら全問未解答扱いで対象外

// buildQuizSet: 絞り込みなしでも questionStats があれば出題回数の少ない問題を優先（偏り防止）
const freqStats = Logic.perQuestionStats([
  { question_id: "1", correct: true, timestamp: 1, confidence: "sure" },
  { question_id: "1", correct: true, timestamp: 2, confidence: "sure" },
  { question_id: "1", correct: true, timestamp: 3, confidence: "sure" },
  { question_id: "2", correct: true, timestamp: 1, confidence: "sure" },
  // id "3" は未出題（questionStatsに存在しない） → times=0扱いで最優先
]);
const balanced = Logic.buildQuizSet(pool, { mode: "random", count: 2, questionStats: freqStats }, rng);
assert.ok(balanced.some(q => q.id === "3")); // 未消化"3"が必ず入る（残り1問は正解の中からランダム）

// status / buildQuizSet: 状態は1つに決める（アプリ > 模試 > 紙）。優先順 = 不正解 → 未消化 → 自信なし → 正解
const stPool = [
  q("s-app-wrong", "A", "s"), q("s-app-unsure", "A", "s"), q("s-app-sure", "A", "s"), q("s-new", "A", "s"),
  q("s-mock-wrong", "A", "s", { prior: [{ source: "mock", correct: false }] }),
  q("s-mock-ok", "A", "s", { prior: [{ source: "mock", correct: true }] }),
  q("s-paper-wrong", "A", "s", { paper_results: ["○", "×"] }),
  q("s-paper-ok-then-app-wrong", "A", "s", { paper_results: ["○", "○"] }),
];
const stStats = Logic.perQuestionStats([
  { question_id: "s-app-wrong", correct: false, timestamp: 1, confidence: "sure" },
  { question_id: "s-app-unsure", correct: true, timestamp: 1, confidence: "guess" },
  { question_id: "s-app-sure", correct: true, timestamp: 1, confidence: "sure" },
  { question_id: "s-paper-ok-then-app-wrong", correct: false, timestamp: 1, confidence: "unsure" },
]);
const stOf = id => Logic.status(stPool.find(x => x.id === id), stStats);
assert.strictEqual(stOf("s-app-wrong"), "wrong"); assert.strictEqual(stOf("s-app-unsure"), "unsure"); assert.strictEqual(stOf("s-app-sure"), "correct");
assert.strictEqual(stOf("s-new"), "new"); assert.strictEqual(stOf("s-mock-wrong"), "wrong"); assert.strictEqual(stOf("s-mock-ok"), "correct");
assert.strictEqual(stOf("s-paper-wrong"), "wrong"); assert.strictEqual(stOf("s-paper-ok-then-app-wrong"), "wrong"); // アプリの結果が紙より優先
const ordered = Logic.buildQuizSet(stPool, { mode: "random", count: 0, questionStats: stStats }, rng).map(x => Logic.status(stPool.find(p => p.id === x.id), stStats));
assert.deepStrictEqual(ordered.map(x => Logic.STATUS_ORDER[x]), [0, 0, 0, 0, 0, 1, 2, 2]); // 未消化と不正解は同列
// 模試で正解した問題は、未消化・不正解・自信なしが残っている限り出ない
const top4 = Logic.buildQuizSet(stPool, { mode: "random", count: 4, questionStats: stStats }, rng);
assert.ok(!top4.some(x => x.id === "s-mock-ok"));
// 同じ「不正解」の中では、アプリで解いた不正解と模試・紙の不正解を区別しない（出題回数で並べない）
let firstApp = 0;
for (let t = 0; t < 40; t++) {
  const top = Logic.buildQuizSet(stPool, { mode: "random", count: 1, questionStats: stStats }, Math.random)[0];
  if (top.id === "s-app-wrong" || top.id === "s-paper-ok-then-app-wrong") firstApp++;
}
assert.ok(firstApp >= 8 && firstApp <= 32, "アプリ不正解が先頭に来る回数が偏っている: " + firstApp); // 期待値 20/40
// categoryStats / trendSummary の消化数に模試・紙の結果を含める
const cs2 = Logic.categoryStats(stPool, [{ question_id: "s-app-sure", correct: true, timestamp: 1, confidence: "sure" }]);
assert.strictEqual(cs2[0].attemptedQuestions, 5); // app1 + mock2 + paper2
assert.strictEqual(cs2[0].wrongNow, 2);           // mock-wrong, paper-wrong
assert.strictEqual(Logic.trendSummary(stPool, [], Date.now()).attempted, 4); // mock2 + paper2（アプリ履歴なし）

// explanationHighlightKey: 括弧書き（読み仮名等）を除いた本体を返す
assert.strictEqual(Logic.explanationHighlightKey("卓袱台（ちゃぶだい）"), "卓袱台");
assert.strictEqual(Logic.explanationHighlightKey("箱膳"), "箱膳");
assert.strictEqual(Logic.explanationHighlightKey("ウィンドウトリートメント"), "ウィンドウトリートメント");
// 正誤2択・1文字以下・非文字列は強調対象外（null）
assert.strictEqual(Logic.explanationHighlightKey("正しい"), null);
assert.strictEqual(Logic.explanationHighlightKey("誤り"), null);
assert.strictEqual(Logic.explanationHighlightKey("木"), null);
assert.strictEqual(Logic.explanationHighlightKey(null), null);
assert.strictEqual(Logic.explanationHighlightKey("（注記のみ）"), null);

// choiceExplanationExcerpt: 丸数字パターン（選んだ肢②の説明区間を、次の丸数字の手前まで抜粋）
const expText = "正答は③無垢材。框戸は框組に鏡板をはめ込んだ構造の戸。①構造用合板は耐力部材として使用できる合板。②縁甲板は長手方向の側面に実はぎ加工が施された長尺の板。床材のほか壁や天井にも用いる。";
assert.strictEqual(
  Logic.choiceExplanationExcerpt(expText, 1, "縁甲板"),
  "②縁甲板は長手方向の側面に実はぎ加工が施された長尺の板。床材のほか壁や天井にも用いる。");
assert.strictEqual(
  Logic.choiceExplanationExcerpt(expText, 0, "構造用合板"),
  "①構造用合板は耐力部材として使用できる合板。");
// 丸数字が無い解説では、肢の語（括弧書き除去）を含む文を抜粋
const expPlain = "鴨居は開口部の上側の部材。長押（なげし）は柱の上部を水平につなぐ化粧材である。敷居は下側の部材。";
assert.strictEqual(
  Logic.choiceExplanationExcerpt(expPlain, 0, "長押（なげし）"),
  "長押（なげし）は柱の上部を水平につなぐ化粧材である。");
// 該当なし・正誤2択・空解説は null（抜粋表示なし）
assert.strictEqual(Logic.choiceExplanationExcerpt(expPlain, 2, "回り縁"), null);
assert.strictEqual(Logic.choiceExplanationExcerpt("この記述は誤りである。", 0, "誤り"), null);
assert.strictEqual(Logic.choiceExplanationExcerpt("", 1, "縁甲板"), null);
assert.strictEqual(Logic.choiceExplanationExcerpt(null, 1, "縁甲板"), null);


// ===================== P2/P3: 模試・SRS・ダッシュボード・弱点集中 =====================
const DAY = 86400000;

// mockPresets: 本番相当=36問×4空欄=144単位・120分、ハーフ/クイックは比例、1問あたり50秒
const presets = Logic.mockPresets();
assert.deepStrictEqual(presets.map(p => [p.key, p.count, p.minutes]), [["full", 144, 120], ["half", 72, 60], ["quick", 36, 30]]);
assert.strictEqual(Logic.mockSecPerQuestion(), 50);

// buildMockSet: 分野構成比に比例した層化抽出・図版除外・件数一致・重複なし
const bank = [];
for (let i = 0; i < 60; i++) bank.push(q(`a${i}`, "計画", "s"));
for (let i = 0; i < 30; i++) bank.push(q(`b${i}`, "法規", "s"));
for (let i = 0; i < 10; i++) bank.push(q(`c${i}`, "歴史", "s"));
bank.push(q("fig", "計画", "s", { has_figure: true }));
const mock = Logic.buildMockSet(bank, 20, null, rng);
assert.strictEqual(mock.length, 20);
assert.strictEqual(new Set(mock.map(x => x.id)).size, 20);
const cnt = cat => mock.filter(x => x.category === cat).length;
assert.deepStrictEqual([cnt("計画"), cnt("法規"), cnt("歴史")], [12, 6, 2]); // 図版1問を含む101問から比例配分（61/30/10→12.1/5.9/2.0）
assert.strictEqual(Logic.buildMockSet(bank, 0, null, rng).length, 100);   // 0=全問（画像なし図版は除外）
assert.strictEqual(Logic.buildMockSet(bank, 999, null, rng).length, 100); // 超過は全問
// 端数配分: 7問を 60/30/10 で割ると 4.2/2.1/0.7 → 4/2/0 + 余り1は端数最大の歴史へ
const mock7 = Logic.buildMockSet(bank, 7, null, rng);
assert.deepStrictEqual([mock7.filter(x => x.category === "計画").length, mock7.filter(x => x.category === "法規").length, mock7.filter(x => x.category === "歴史").length], [4, 2, 1]);

// gradeMock: 未解答は不正解扱い・attempts は mode/session_id 付き・confidence なし
const mlist = [q("m1", "A", "s", { answer: 0 }), q("m2", "A", "s", { answer: 1 }), q("m3", "B", "s", { answer: 2 })];
const g = Logic.gradeMock(mlist, [{ choice: 0, time_sec: 10 }, { choice: 0, time_sec: 20 }, { choice: null, time_sec: 5 }], "sess1", 1000);
assert.strictEqual(g.total, 3); assert.strictEqual(g.correct, 1); assert.strictEqual(g.skipped, 1);
assert.strictEqual(g.rate, 33); assert.strictEqual(g.timeSec, 35);
assert.strictEqual(g.attempts[0].mode, "mock"); assert.strictEqual(g.attempts[0].session_id, "sess1");
assert.strictEqual(g.attempts[0].confidence, null);
assert.strictEqual(g.attempts[2].correct, false); assert.strictEqual(g.attempts[2].skipped, true);
assert.deepStrictEqual(g.attempts.map(a => a.timestamp), [1000, 1001, 1002]);

// mockSeries: session_id で束ね時系列順。演習（mode なし）は含めない
const series = Logic.mockSeries([
  ...g.attempts,
  { question_id: "x", timestamp: 50, correct: true, time_sec: 1, mode: "mock", session_id: "sess0" },
  { question_id: "y", timestamp: 2000, correct: true, time_sec: 1, confidence: "sure" },
]);
assert.deepStrictEqual(series.map(s => [s.session_id, s.rate, s.total]), [["sess0", 100, 1], ["sess1", 33, 3]]);

// srsQuality: 確信誤答=0・他誤答=1・正解は確信5/迷い4/勘3・模試正解(自信度なし)=4
assert.strictEqual(Logic.srsQuality({ correct: false, confidence: "sure" }), 0);
assert.strictEqual(Logic.srsQuality({ correct: false, confidence: "guess" }), 1);
assert.strictEqual(Logic.srsQuality({ correct: true, confidence: "sure" }), 5);
assert.strictEqual(Logic.srsQuality({ correct: true, confidence: "unsure" }), 4);
assert.strictEqual(Logic.srsQuality({ correct: true, confidence: "guess" }), 3);
assert.strictEqual(Logic.srsQuality({ correct: true, confidence: null }), 4);

// srsStates: SM-2 再生。正解1回目=1日、2回目=6日、3回目=round(6×ease)。誤答で reps リセット→1日
const t0 = 1_000_000_000_000;
let srs = Logic.srsStates([
  { question_id: "s1", timestamp: t0, correct: true, confidence: "sure" },
  { question_id: "s1", timestamp: t0 + DAY, correct: true, confidence: "sure" },
  { question_id: "s1", timestamp: t0 + 7 * DAY, correct: true, confidence: "sure" },
]);
assert.strictEqual(srs.get("s1").reps, 3);
assert.strictEqual(srs.get("s1").interval, Math.round(6 * 2.7)); // ease 2.5→2.6→2.7 の時点で3回目
assert.strictEqual(srs.get("s1").nextDue, t0 + 7 * DAY + srs.get("s1").interval * DAY);
srs = Logic.srsStates([
  { question_id: "s2", timestamp: t0 + 5 * DAY, correct: true, confidence: "sure" },  // 時刻順に並べ替えて再生されること
  { question_id: "s2", timestamp: t0, correct: true, confidence: "sure" },
  { question_id: "s2", timestamp: t0 + 6 * DAY, correct: false, confidence: "sure" },
]);
assert.strictEqual(srs.get("s2").reps, 0);
assert.strictEqual(srs.get("s2").interval, 1);
assert.strictEqual(srs.get("s2").nextDue, t0 + 7 * DAY);
assert.ok(srs.get("s2").ease < 2.5 && srs.get("s2").ease >= 1.3);
// ease の下限 1.3
let low = Logic.srsStates(Array.from({ length: 20 }, (_, i) => ({ question_id: "s3", timestamp: t0 + i, correct: false, confidence: "sure" })));
assert.strictEqual(low.get("s3").ease, 1.3);

// srsDueQuestions: nextDue 到来分のみ・期限超過が大きい順・未解答は対象外・図版除外
const srsPool = [q("s1", "A", "x"), q("s2", "A", "x"), q("s4", "A", "x"), q("s5", "A", "x", { has_figure: true })];
const srsAtt = [
  { question_id: "s1", timestamp: t0, correct: true, confidence: "sure" },           // due t0+1日
  { question_id: "s2", timestamp: t0 - 3 * DAY, correct: false, confidence: "guess" }, // due t0-2日（より超過）
  { question_id: "s5", timestamp: t0 - 3 * DAY, correct: false, confidence: "guess" },
];
assert.deepStrictEqual(Logic.srsDueQuestions(srsPool, srsAtt, t0 + 2 * DAY).map(x => x.id), ["s2", "s1"]); // 画像なし図版 s5 は除外
assert.deepStrictEqual(Logic.srsDueQuestions(srsPool, srsAtt, t0).map(x => x.id), ["s2"]);

// latestAttempts / confidenceMatrix: 最新解答で4象限（＋自信度なし）に分類
const cmPool = [q("c1", "A", "x"), q("c2", "A", "x"), q("c3", "A", "x"), q("c4", "A", "x"), q("c5", "A", "x"), q("c6", "A", "x")];
const cmAtt = [
  { question_id: "c1", timestamp: 1, correct: false, confidence: "sure" },
  { question_id: "c1", timestamp: 2, correct: true, confidence: "sure" },   // 最新=確信正解
  { question_id: "c2", timestamp: 1, correct: false, confidence: "sure" },  // 確信誤答
  { question_id: "c3", timestamp: 1, correct: true, confidence: "guess" },  // 勘正解
  { question_id: "c4", timestamp: 1, correct: false, confidence: "unsure" },// 迷い誤答
  { question_id: "c5", timestamp: 1, correct: true, confidence: null, mode: "mock" }, // 模試のみ
  { question_id: "c2", timestamp: 9, correct: true, confidence: null, mode: "mock" },  // 模試で後から正解しても演習の確信誤答判定を保持
];
assert.strictEqual(Logic.latestAttempts(cmAtt).get("c1").timestamp, 2);
assert.strictEqual(Logic.latestAttempts(cmAtt).get("c2").timestamp, 9);
const cm = Logic.confidenceMatrix(cmPool, cmAtt);
assert.deepStrictEqual(cm.sureCorrect, ["c1"]); assert.deepStrictEqual(cm.sureWrong, ["c2"]);
assert.deepStrictEqual(cm.guessCorrect, ["c3"]); assert.deepStrictEqual(cm.guessWrong, ["c4"]);
assert.deepStrictEqual(cm.noConfCorrect, ["c5"]); assert.deepStrictEqual(cm.noConfWrong, []);

// heatmapRows: 小分類単位の集計・優先度 = (1−最新正答率)×(1+確信誤答率)×重み
const hmPool = [q("h1", "計画", "動線"), q("h2", "計画", "動線"), q("h3", "計画", "寸法"), q("h4", "法規", "建基法")];
const hmAtt = [
  { question_id: "h1", timestamp: 1, correct: false, confidence: "sure", time_sec: 70 },
  { question_id: "h2", timestamp: 1, correct: true, confidence: "sure", time_sec: 30 },
  { question_id: "h4", timestamp: 1, correct: true, confidence: "sure", time_sec: 40 },
];
const hm = Logic.heatmapRows(hmPool, hmAtt);
const dosen = hm.find(r => r.subcategory === "動線");
assert.strictEqual(dosen.total, 2); assert.strictEqual(dosen.attempted, 2);
assert.strictEqual(dosen.latestAccuracy, 50); assert.strictEqual(dosen.accuracy, 50);
assert.strictEqual(dosen.sureWrong, 1); assert.strictEqual(dosen.avgTime, 50);
assert.strictEqual(dosen.weight, 1.5); // 計画3/4問 ÷ 平均シェア1/2
assert.strictEqual(dosen.priority, Math.round(0.5 * 1.5 * 1.5 * 100) / 100);
const sunpo = hm.find(r => r.subcategory === "寸法");
assert.strictEqual(sunpo.latestAccuracy, null); assert.strictEqual(sunpo.priority, Math.round(0.5 * 1 * 1.5 * 100) / 100); // 未着手=0.5
const kenki = hm.find(r => r.subcategory === "建基法");
assert.strictEqual(kenki.priority, 0);
assert.strictEqual(hm[0].subcategory, "動線"); // 優先度降順

// heatLevel
assert.deepStrictEqual([null, 0, 49, 50, 64, 65, 74, 75, 84, 85, 100].map(Logic.heatLevel), [-1, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4]);

// buildWeakSet: 確信誤答 > 他誤答 > 勘正解 > 未着手 > 確信正解 の順、count で切る
const weak = Logic.buildWeakSet(hmPool, hmAtt, 0, rng);
assert.strictEqual(weak[0].id, "h1");           // 確信誤答＋優先小分類
assert.strictEqual(weak[weak.length - 1].id, "h4"); // 確信正解・優先度0
assert.strictEqual(Logic.buildWeakSet(hmPool, hmAtt, 2, rng).length, 2);
assert.strictEqual(Logic.buildWeakSet([...hmPool, q("hf", "計画", "動線", { has_figure: true })], hmAtt, 0, rng).length, 4); // 画像なし図版は除外
assert.strictEqual(Logic.buildWeakSet([...hmPool, q("hf2", "計画", "動線", { has_figure: true, figure_data: "data:image/png;base64,AAAA" })], hmAtt, 0, rng).length, 5); // 画像ありの図版は含む

// timeDistribution: 予算超過率・正解でも超過した割合
const td = Logic.timeDistribution(hmPool, [
  ...hmAtt,
  { question_id: "h2", timestamp: 2, correct: true, confidence: "sure", time_sec: 90 },
], 50);
const tdPlan = td.find(c => c.category === "計画");
assert.strictEqual(tdPlan.n, 3); assert.strictEqual(tdPlan.avgTime, 63);
assert.strictEqual(tdPlan.overRate, 67); assert.strictEqual(tdPlan.correctOverRate, 50);
assert.strictEqual(td[0].category, "計画"); // 超過率降順

// dailyAccuracy: 直近N日・日別・解答のあった日のみ
const dnow = new Date(2026, 9, 11, 12).getTime();
const da = Logic.dailyAccuracy([
  { timestamp: dnow, correct: true }, { timestamp: dnow - 3600000, correct: false },
  { timestamp: dnow - DAY, correct: true },
  { timestamp: dnow - 20 * DAY, correct: true },
], 14, dnow);
assert.deepStrictEqual(da.map(d => [d.date, d.total, d.rate]), [["2026-10-10", 1, 100], ["2026-10-11", 2, 50]]);

// fmtClock
assert.strictEqual(Logic.fmtClock(0), "0:00");
assert.strictEqual(Logic.fmtClock(65), "1:05");
assert.strictEqual(Logic.fmtClock(7200), "2:00:00");
assert.strictEqual(Logic.fmtClock(-5), "0:00");


// paperMark: 手書き○×の要約（直近×、2周連続×、直近○、記録なし）
assert.strictEqual(Logic.paperMark({ paper_results: ["×", "×"] }), "xx");
assert.strictEqual(Logic.paperMark({ paper_results: ["○", "×"] }), "x");
assert.strictEqual(Logic.paperMark({ paper_results: ["×", "○"] }), "o");
assert.strictEqual(Logic.paperMark({ paper_results: ["?"] }), null);
assert.strictEqual(Logic.paperMark({}), null);

// paperStats: 分野別の紙演習集計（図版除外）
const ppool = [q("p1", "A", "s", { paper_results: ["×", "×"] }), q("p2", "A", "s", { paper_results: ["○"] }), q("p3", "B", "s"), q("p4", "A", "s", { paper_results: ["×"], has_figure: true })];
const ps = Logic.paperStats(ppool);
assert.deepStrictEqual(ps.get("A"), { marked: 2, latestX: 1, xx: 1 }); // 画像なし図版 p4 は除外
assert.strictEqual(ps.get("B"), undefined);

// buildWeakSet: アプリ未解答なら紙の×を優先シグナルに使う（×× > × > 未記録 > ○）
const wpool = [q("w1", "A", "s", { paper_results: ["○"] }), q("w2", "A", "s", { paper_results: ["×", "×"] }), q("w3", "A", "s"), q("w4", "A", "s", { paper_results: ["○", "×"] })];
assert.deepStrictEqual(Logic.buildWeakSet(wpool, [], 0, rng).map(x => x.id), ["w2", "w4", "w3", "w1"]);

// trendSummary: 着手率・模試・週次・優先分野
const tnow = Date.now();
const tpool = [q("t1", "歴史", "s", { paper_results: ["×"] }), q("t2", "歴史", "s"), q("t3", "法規", "s"), q("t4", "法規", "s")];
const tatt = [
  { question_id: "t1", timestamp: tnow - DAY, correct: false, confidence: "sure", time_sec: 10 },
  { question_id: "t3", timestamp: tnow - DAY, correct: true, confidence: "sure", time_sec: 10 },
  { question_id: "t4", timestamp: tnow - 10 * DAY, correct: true, confidence: "sure", time_sec: 10 },
  { question_id: "m1", timestamp: tnow - 2 * DAY, correct: true, time_sec: 0, mode: "mock", session_id: "s1" },
  { question_id: "m2", timestamp: tnow - 2 * DAY, correct: false, time_sec: 0, mode: "mock", session_id: "s1" },
];
const ts = Logic.trendSummary(tpool, tatt, tnow);
assert.strictEqual(ts.total, 4); assert.strictEqual(ts.attempted, 3); assert.strictEqual(ts.coverage, 75);
assert.strictEqual(ts.latestMock.rate, 50); assert.strictEqual(ts.prevMock, null); assert.strictEqual(ts.passGap, 20);
assert.strictEqual(ts.week.n, 4); assert.strictEqual(ts.week.rate, 50);
assert.strictEqual(ts.prevWeek.n, 1); assert.strictEqual(ts.prevWeek.rate, 100);
assert.strictEqual(ts.priorities[0].category, "歴史"); // アプリ誤答＋紙×＋確信誤答
assert.strictEqual(ts.priorities[0].sureWrong, 1); assert.strictEqual(ts.priorities[0].paperXRate, 100);
assert.strictEqual(ts.priorities[1].category, "法規"); assert.strictEqual(ts.priorities[1].appAccuracy, 100);
assert.strictEqual(ts.sureWrong, 1); assert.strictEqual(ts.due, 3); // 1日前の解答2件＋10日前の1件が期限到来
assert.strictEqual(Logic.trendSummary([], [], tnow).passGap, null);

console.log("all logic tests passed");
