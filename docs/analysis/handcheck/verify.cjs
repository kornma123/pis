const fs = require('fs');
const P = '/Users/maxiaoyuan/Documents/coreone-phase2';
const fx = JSON.parse(fs.readFileSync(P + '/后端代码/server/tests/fixtures/statements/out_line_item__hemujia_2602.json', 'utf8'));
const lisArr = JSON.parse(fs.readFileSync(P + '/docs/analysis/data/lis-hemujia-workload.json', 'utf8'));
const lis = {};
for (const r of lisArr) lis[String(r.no).toUpperCase()] = r;

// ---- Parse settlement grid into per-case buckets (independent of golden script) ----
const cases = {};
for (const r of fx.grid) {
  const no = String(r[1] || '').trim().toUpperCase();
  const it = String(r[5] || '').trim();
  const net = parseFloat(r[10]);
  const q = parseFloat(r[7]) || 1;
  if (!no || !it || isNaN(net) || /合计|小计/.test(no) || /合计|小计/.test(it)) continue;
  const c = (cases[no] = cases[no] || { histo: 0, tct: 0, frozen: 0, stain: 0, diag: 0, hq: 0, tq: 0, fq: 0 });
  if (/现场服务|报告/.test(it)) c.diag += net;
  else if (/免疫组化|特殊染色|酶组织化学/.test(it)) c.stain += net;
  else if (/TCT/.test(it)) { c.tct += net; c.tq += q; }
  else if (/术中|冰冻切片/.test(it)) { c.frozen += net; c.fq += q; }
  else if (/检查与诊断/.test(it)) { c.histo += net; c.hq += q; }
}

const DIAG = 105, RT = 36, RC = 75;
const all = Object.keys(cases);
const matched = all.filter(no => lis[no]);

// ---- Revenue split (making-share) ----
let revHisto = 0, revStain = 0, revTct = 0, revFrozen = 0, diagBucket = 0;
let totalMakingShareCheck = 0, totalDiagShareCheck = 0;
for (const no of all) {
  const c = cases[no];
  // stain: whole line to lab revenue, no split
  revStain += c.stain;
  // diag bucket base
  diagBucket += c.diag;
  // histo: split by LIS blk
  if (c.histo > 0) {
    const blk = lis[no] ? lis[no].blk : c.hq;
    const f = (RT * blk) / (RT * blk + DIAG);
    revHisto += c.histo * f;
    diagBucket += c.histo * (1 - f);
  }
  // tct
  if (c.tct > 0) {
    const f = (RC * c.tq) / (RC * c.tq + DIAG);
    revTct += c.tct * f;
    diagBucket += c.tct * (1 - f);
  }
  // frozen
  if (c.frozen > 0) {
    const f = (RT * c.fq) / (RT * c.fq + DIAG);
    revFrozen += c.frozen * f;
    diagBucket += c.frozen * (1 - f);
  }
}
const revTotal = revHisto + revStain + revTct + revFrozen;

// conservation: total grid net = revTotal + diagBucket ?
let gridNet = 0;
for (const no of all) { const c = cases[no]; gridNet += c.histo + c.stain + c.tct + c.frozen + c.diag; }

// ---- Physical units ----
let blkTotal = 0, ihcTotal = 0, spTotal = 0, tctSlides = 0, frozenCases = 0;
for (const no of all) {
  const c = cases[no];
  if (lis[no]) { blkTotal += lis[no].blk || 0; ihcTotal += lis[no].ihc || 0; spTotal += lis[no].sp || 0; }
  tctSlides += c.tq;
  frozenCases += c.fq;
}

// ---- Cost side (G2 unit costs) ----
// tissue block: 30-50, IHC reagent: 18 (原液) or 48 (即用), SP: 10-30, TCT: 28-52, frozen: 40-90
function cost(band) {
  const b = { lo: { blk: 30, ihc: 18, sp: 10, tct: 28, frozen: 40 },
              mid:{ blk: 40, ihc: 33, sp: 20, tct: 40, frozen: 65 },
              hi: { blk: 50, ihc: 48, sp: 30, tct: 52, frozen: 90 } }[band];
  return {
    histo: blkTotal * b.blk,
    ihc: ihcTotal * b.ihc,
    sp: spTotal * b.sp,
    tct: tctSlides * b.tct,
    frozen: frozenCases * b.frozen,
    total: blkTotal*b.blk + ihcTotal*b.ihc + spTotal*b.sp + tctSlides*b.tct + frozenCases*b.frozen
  };
}
const cLo = cost('lo'), cMid = cost('mid'), cHi = cost('hi');

const R = x => Math.round(x);
console.log('=== 病例/匹配 ===');
console.log('对账单病例:', all.length, '| LIS匹配:', matched.length);
console.log('=== 收入(纯实验室) ===');
console.log('组织制片:', R(revHisto), '| 染色:', R(revStain), '| TCT:', R(revTct), '| 冰冻:', R(revFrozen));
console.log('纯实验室 IN 合计:', R(revTotal), '| 诊断桶:', R(diagBucket), '| 守恒 IN+诊断:', R(revTotal + diagBucket), '| grid净额:', R(gridNet));
console.log('=== 物理单位 ===');
console.log('蜡块:', blkTotal, '| 免疫组化:', ihcTotal, '| 特染:', spTotal, '| TCT玻片:', tctSlides, '| 冰冻例:', frozenCases);
console.log('=== 成本 G2 ===');
console.log('lo :', R(cLo.total), '| mid:', R(cMid.total), '| hi:', R(cHi.total));
console.log('  mid明细: 组织', R(cMid.histo), '免疫组化', R(cMid.ihc), '特染', R(cMid.sp), 'TCT', R(cMid.tct), '冰冻', R(cMid.frozen));
console.log('=== 毛利 ===');
console.log('毛利 mid:', R(revTotal - cMid.total), '| band', R(revTotal - cHi.total), '~', R(revTotal - cLo.total));
console.log('毛利率 mid:', ((revTotal - cMid.total) / revTotal * 100).toFixed(1) + '%');
console.log('=== 逐线毛利率(mid) ===');
console.log('组织:', ((revHisto - cMid.histo)/revHisto*100).toFixed(0)+'%');
console.log('免疫组化(收入染色整条 vs 成本免疫组化+特染):');
const stainCostMid = cMid.ihc + cMid.sp;
console.log('  染色收入', R(revStain), '染色成本mid', R(stainCostMid), '毛利率', ((revStain - stainCostMid)/revStain*100).toFixed(0)+'%');
console.log('TCT:', ((revTct - cMid.tct)/revTct*100).toFixed(0)+'%');
console.log('冰冻:', ((revFrozen - cMid.frozen)/revFrozen*100).toFixed(0)+'%', '(收入', R(revFrozen), '成本', R(cMid.frozen)+')');

console.log('=== 逐例抽查 ===');
for (const key of ['S26-00460','S26-00472','S26-00783']) {
  const c = cases[key]; const l = lis[key];
  if (!c) { console.log(key, 'NOT FOUND'); continue; }
  const blk = l ? l.blk : c.hq;
  const f = c.histo>0 ? (RT*blk)/(RT*blk+DIAG) : 0;
  const rev = c.histo*f + c.stain + c.tct*(c.tq? (RC*c.tq)/(RC*c.tq+DIAG):0) + c.frozen*(c.fq? (RT*c.fq)/(RT*c.fq+DIAG):0);
  console.log(key, 'blk='+blk, 'ihc='+(l?l.ihc:'?'), 'histoNet='+R(c.histo), 'stainNet='+R(c.stain), 'f='+f.toFixed(3), 'labRev='+R(rev),
    'costMid(blk*40+ihc*33)='+R(blk*40+(l?l.ihc:0)*33), 'costBand='+R(blk*30+(l?l.ihc:0)*18)+'~'+R(blk*50+(l?l.ihc:0)*48));
}
