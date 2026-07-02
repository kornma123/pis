/**
 * T1 真数据手核：物理工序单位桥接 —— 收入侧(制片份额/染色整条) vs 成本侧(G2单位成本×物理单位) = 毛利
 * 复用 phase2 已脱敏 committed 数据（同 hemujia-golden-lis-join.cjs 口径），不碰 ~/Downloads。
 * G2 单位技术成本(midpoint/band): 组织¥40[30-50]/蜡块; 免疫组化 原液¥18|即用¥48/抗体; 特染¥20[10-30]/次; TCT¥40[28-52]/玻片; 冰冻¥65[40-90]/例
 */
const fs = require('fs');
const path = require('path');
const P2 = '/Users/maxiaoyuan/Documents/coreone-phase2';
const fx = JSON.parse(fs.readFileSync(path.join(P2, '后端代码/server/tests/fixtures/statements/out_line_item__hemujia_2602.json'), 'utf8'));
const lisArr = JSON.parse(fs.readFileSync(path.join(P2, 'docs/analysis/data/lis-hemujia-workload.json'), 'utf8'));
const lis = {}; for (const r of lisArr) lis[String(r.no).toUpperCase()] = r;

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
// G2 单位成本
const C = { blk: [30, 40, 50], ihcRaw: 18, ihcRTU: 48, sp: [10, 20, 30], tct: [28, 40, 52], frz: [40, 65, 90] };

const all = Object.keys(cases);
let sumBlk = 0, sumIhc = 0, sumSp = 0, sumTq = 0, sumFq = 0;
let revHisto = 0, revStain = 0, revTct = 0, revFrz = 0;
const rows = [];
for (const no of all) {
  const c = cases[no]; const L = lis[no] || { blk: 0, ihc: 0, sp: 0 };
  const blk = L.blk, ihc = L.ihc, sp = L.sp;
  sumBlk += blk; sumIhc += ihc; sumSp += sp; sumTq += c.tq; sumFq += c.fq;
  let hIN = 0;
  if (c.histo > 0) { const f = (RT * blk) / (RT * blk + DIAG); hIN = c.histo * f; revHisto += hIN; }
  revStain += c.inW;
  if (c.tct > 0) { const f = (RC * c.tq) / (RC * c.tq + DIAG); revTct += c.tct * f; }
  if (c.frozen > 0) { const f = (RT * c.fq) / (RT * c.fq + DIAG); revFrz += c.frozen * f; }
  // 该例 IN 收入(制片+染色+TCT+冰冻份额)
  const inRev = hIN + c.inW + (c.tct > 0 ? c.tct * (RC * c.tq) / (RC * c.tq + DIAG) : 0) + (c.frozen > 0 ? c.frozen * (RT * c.fq) / (RT * c.fq + DIAG) : 0);
  // 该例 成本 band（IHC 原液~即用 双界）
  const costLo = blk * C.blk[0] + ihc * C.ihcRaw + sp * C.sp[0] + c.tq * C.tct[0] + c.fq * C.frz[0];
  const costHi = blk * C.blk[2] + ihc * C.ihcRTU + sp * C.sp[2] + c.tq * C.tct[2] + c.fq * C.frz[2];
  rows.push({ no, blk, ihc, sp, histoNet: c.histo, stainNet: c.inW, tctNet: c.tct, frzNet: c.frozen, hIN, inRev, costLo, costHi });
}

// ---- 逐病例样本（挑代表：单块HE-only / HE+多IHC / 高块 / TCT / 冰冻）----
const pick = [];
const byIhc = [...rows].sort((a, b) => b.ihc - a.ihc);
const byBlk = [...rows].sort((a, b) => b.blk - a.blk);
pick.push(rows.find(r => r.histoNet > 0 && r.ihc === 0 && r.blk === 1)); // 单块HE-only
pick.push(byIhc[0]);                                                     // 最多IHC
pick.push(byIhc[3]);
pick.push(byBlk[0]);                                                     // 最多蜡块
pick.push(rows.find(r => r.tctNet > 0));                                 // TCT
pick.push(rows.find(r => r.frzNet > 0));                                 // 冰冻
pick.push(rows.find(r => r.histoNet > 0 && r.ihc >= 1 && r.blk >= 2 && r.stainNet > 0));
const seen = new Set();
console.log('===== 逐病例手核样本（收入=制片份额+染色整条；成本=物理单位×G2；毛利band取IHC原液~即用）=====');
console.log('病理号\t蜡块\tIHC\t特染\t组织收费\t组织制片份额\t染色收费\t→IN收入\t成本[低~高]\t毛利[低~高]\t毛利率%');
for (const r of pick) {
  if (!r || seen.has(r.no)) continue; seen.add(r.no);
  const mLo = r.inRev - r.costHi, mHi = r.inRev - r.costLo;
  const rateLo = r.inRev > 0 ? (mLo / r.inRev * 100) : 0, rateHi = r.inRev > 0 ? (mHi / r.inRev * 100) : 0;
  console.log(`${r.no}\t${r.blk}\t${r.ihc}\t${r.sp}\t${r.histoNet.toFixed(0)}\t${r.hIN.toFixed(1)}\t${r.stainNet.toFixed(0)}\t${r.inRev.toFixed(1)}\t${r.costLo.toFixed(0)}~${r.costHi.toFixed(0)}\t${mLo.toFixed(0)}~${mHi.toFixed(0)}\t${rateLo.toFixed(0)}~${rateHi.toFixed(0)}`);
}

// ---- 全月 165 例 按线 收入 vs 成本band vs 毛利 ----
const line = (name, rev, units, unit, cLo, cMid, cHi) => {
  const costLo = units * cLo, costMid = units * cMid, costHi = units * cHi;
  console.log(`${name}\t收入¥${rev.toFixed(0)}\t物理单位=${units}(${unit})\t成本¥${costLo.toFixed(0)}~${costMid.toFixed(0)}~${costHi.toFixed(0)}\t毛利¥${(rev-costHi).toFixed(0)}~${(rev-costMid).toFixed(0)}~${(rev-costLo).toFixed(0)}\t毛利率${((rev-costMid)/rev*100).toFixed(0)}%(mid)`);
};
console.log('\n===== 全月165例 按业务线 收入 vs 成本band vs 毛利 =====');
console.log('业务线\t收入\t物理单位\t成本[低~中~高]\t毛利[低~中~高]\t毛利率(中)');
line('组织学制片', revHisto, sumBlk, '蜡块', C.blk[0], C.blk[1], C.blk[2]);
line('免疫组化(染色收入含特染)', revStain, sumIhc, '抗体', C.ihcRaw, (C.ihcRaw + C.ihcRTU) / 2, C.ihcRTU);
console.log(`  └(染色收入¥${revStain.toFixed(0)}还含特染${sumSp}次×¥10~30=¥${(sumSp*10).toFixed(0)}~${(sumSp*30).toFixed(0)}成本，未从染色收入里单拆)`);
line('细胞TCT', revTct, sumTq, '玻片', C.tct[0], C.tct[1], C.tct[2]);
line('院内冰冻', revFrz, sumFq, '例', C.frz[0], C.frz[1], C.frz[2]);
const totRev = revHisto + revStain + revTct + revFrz;
const totCostMid = sumBlk * C.blk[1] + sumIhc * (C.ihcRaw + C.ihcRTU) / 2 + sumSp * C.sp[1] + sumTq * C.tct[1] + sumFq * C.frz[1];
const totCostLo = sumBlk * C.blk[0] + sumIhc * C.ihcRaw + sumSp * C.sp[0] + sumTq * C.tct[0] + sumFq * C.frz[0];
const totCostHi = sumBlk * C.blk[2] + sumIhc * C.ihcRTU + sumSp * C.sp[2] + sumTq * C.tct[2] + sumFq * C.frz[2];
console.log(`\n合计\t纯实验室收入¥${totRev.toFixed(0)}(应=27870)\t成本¥${totCostLo.toFixed(0)}~${totCostMid.toFixed(0)}~${totCostHi.toFixed(0)}\t毛利¥${(totRev-totCostHi).toFixed(0)}~${(totRev-totCostMid).toFixed(0)}~${(totRev-totCostLo).toFixed(0)}\t毛利率${((totRev-totCostMid)/totRev*100).toFixed(0)}%(mid)`);
console.log(`物理单位合计: 蜡块${sumBlk} / 免疫组化${sumIhc} / 特染${sumSp} / TCT玻片${sumTq} / 冰冻${sumFq}`);
console.log(`守恒校验: 组织${revHisto.toFixed(0)}+染色${revStain.toFixed(0)}+TCT${revTct.toFixed(0)}+冰冻${revFrz.toFixed(0)} = ${totRev.toFixed(0)}`);
