/**
 * 复现和睦家纯实验室 golden（全月26.2）= ¥27,870（自足，无需 ~/Downloads，数据已脱敏最小化 committed）。
 * 用法: node docs/analysis/hemujia-golden-lis-join.cjs（数据漂移即断言失败退出 1，见文末）
 * 数据（可审计字段清单，codex 09 · HIGH-2 修正）:
 *   - 后端代码/server/tests/fixtures/statements/out_line_item__hemujia_2602.json（结算表26.2）
 *       保留列=病理号+项目名称+数量+金额+扣率；已置空列=登记日期/伪名/性别/年龄/MRN（表头标「(已置空)」）。
 *   - docs/analysis/data/lis-hemujia-workload.json（LIS：病理号+送检院+蜡块/免疫组化/特染 数，无患者 PII）
 * 口径: 制片份额=36×LIS蜡块/(36×LIS蜡块+105) 逐病例; 染色=IN整条; 报告/现场=诊断桶; 检诊/TCT/冰冻=拆。
 */
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '../..');
const fx = JSON.parse(fs.readFileSync(path.join(root, '后端代码/server/tests/fixtures/statements/out_line_item__hemujia_2602.json'), 'utf8'));
const lisArr = JSON.parse(fs.readFileSync(path.join(__dirname, 'data/lis-hemujia-workload.json'), 'utf8'));
const lis = {}; for (const r of lisArr) lis[String(r.no).toUpperCase()] = r;

// 结算表 grid 列: 病理号1 / 项目名称5 / 数量7 / 结算金额10
const cases = {};
for (const r of fx.grid) {
  const no = String(r[1] || '').trim().toUpperCase(), it = String(r[5] || '').trim(), net = parseFloat(r[10]), q = parseFloat(r[7]) || 1;
  if (!no || !it || isNaN(net) || /合计|小计/.test(no) || /合计|小计/.test(it)) continue;
  const c = (cases[no] = cases[no] || { histo: 0, tct: 0, frozen: 0, inW: 0, diag: 0, hq: 0, tq: 0, fq: 0 });
  if (/现场服务|报告/.test(it)) c.diag += net;
  else if (/免疫组化|特殊染色|酶组织化学/.test(it)) c.inW += net;
  else if (/TCT/.test(it)) { c.tct += net; c.tq += q; }
  else if (/术中|冰冻切片/.test(it)) { c.frozen += net; c.fq += q; }
  else if (/检查与诊断/.test(it)) { c.histo += net; c.hq += q; }
}

const DIAG = 105, RT = 36, RC = 75;
const all = Object.keys(cases), matched = all.filter((no) => lis[no]);
// 按业务线分账（codex MED-4：诚实标明工作量来源）：组织=LIS真蜡块 / TCT·冰冻=账单数量 / 染色=整条IN。
let IN = 0, D = 0, histoIN = 0, tctIN = 0, frozenIN = 0, stainIN = 0, blk0 = 0;
for (const no of all) {
  const c = cases[no]; IN += c.inW; stainIN += c.inW; D += c.diag;
  if (c.histo > 0) {
    const hasLis = !!lis[no]; const blk = hasLis ? lis[no].blk : c.hq; // 全月 golden：全部命中 LIS，无降级
    if (hasLis && blk === 0) blk0++;
    const f = (RT * blk) / (RT * blk + DIAG); IN += c.histo * f; histoIN += c.histo * f; D += c.histo * (1 - f);
  }
  if (c.tct > 0) { const f = (RC * c.tq) / (RC * c.tq + DIAG); IN += c.tct * f; tctIN += c.tct * f; D += c.tct * (1 - f); }
  if (c.frozen > 0) { const f = (RT * c.fq) / (RT * c.fq + DIAG); IN += c.frozen * f; frozenIN += c.frozen * f; D += c.frozen * (1 - f); }
}
console.log('对账单病例:', all.length, '| LIS匹配:', matched.length, `(${(matched.length / all.length * 100).toFixed(0)}%)`, `| 其中蜡块=0(多为TCT/细胞):`, blk0);
console.log('纯实验室 IN = ¥' + Math.round(IN), '| 诊断桶 = ¥' + Math.round(D), '| 守恒 =', Math.round(IN + D));
console.log('  按业务线 IN 来源: 组织制片(LIS蜡块) ¥' + Math.round(histoIN), '/ 染色(整条) ¥' + Math.round(stainIN),
  '/ TCT(账单数量) ¥' + Math.round(tctIN), '/ 冰冻(账单数量) ¥' + Math.round(frozenIN));

// —— 硬断言（codex MED-3）：作为可交接/CI 核验脚本，数据漂移即 fail，不静默给数出 0 退出 ——
const assert = (cond, msg) => { if (!cond) { console.error('❌ 断言失败:', msg); process.exit(1); } };
assert(all.length === 165, `对账单病例数应为 165，实为 ${all.length}`);
assert(matched.length === 165, `LIS 匹配数应为 165，实为 ${matched.length}`);
assert(Math.round(IN) === 27870, `纯实验室 IN 应为 27870，实为 ${Math.round(IN)}`);
assert(Math.round(D) === 27671, `诊断桶应为 27671，实为 ${Math.round(D)}`);
assert(Math.round(IN + D) === 55541, `守恒应为 55541，实为 ${Math.round(IN + D)}`);
console.log('✅ 全部断言通过（IN 27870 / 诊断 27671 / 守恒 55541 / 165病例100%匹配）');
