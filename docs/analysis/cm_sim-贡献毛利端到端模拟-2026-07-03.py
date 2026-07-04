# -*- coding: utf-8 -*-
"""
贡献毛利(contribution margin)院级成本逻辑 —— 端到端数值模拟。
目标：用贴近真实的假设数据 + 还原真实采购行为，跑一遍计算，看逻辑在哪儿裂。
所有金额单位=元。收入/耗材单价均为【假设值】，标注清楚，重点是检验"逻辑结构"而非精确数字。
"""
import random
random.seed(42)

# ========== 1. 约定抗体价台账（元/片·一抗成本） ==========
# 覆盖真实台账的价差跨度(¥0.29~99.82)，含真缺价(None)几种
LEDGER = {
    'Ki-67': 4.26, 'CK7': 3.5, 'CK20': 3.8, 'Vimentin': 2.1, 'CD20': 6.0,
    'CD3': 5.5, 'P53': 4.0, 'S-100': 7.0, 'Desmin': 5.0, 'EMA': 3.2, 'AFP': 0.29,
    'PD-L1': 62.0, 'ALK': 55.0, 'HER2': 40.0, '2SC': 99.82,      # 贵
    'GPNMB': None, 'TROP-2': None, 'PD-1': None,                  # 真缺价 → 标 None
}
SECONDARY_VAR = 12.0   # 二抗+显色+玻片，每张IHC片(变动·假设)
SS_VAR        = 8.0    # 特染盒摊每片(变动·假设)
HE_VAR        = 3.0    # HE/基础制片耗材，每例(变动·假设)

# ========== 2. 收入（实收，元）——假设 ==========
REV_IHC = 55.0   # 免疫组化 每片实收(扣率后)
REV_SS  = 45.0   # 特染 每片实收
REV_HE  = 25.0   # HE/基础(取材+制片) 每例实收

# ========== 3. 实验室固定成本（季度，元）——"这个数肯定有"，财务给 ==========
FIXED_COST_QUARTER = 600_000.0   # 人力+折旧+房租，实物工序口径，不含诊断医生

# ========== 4. 医院画像（case mix 刻意不同，就是要看模型能不能区分） ==========
POOLS = {
    'expensive': ['Ki-67','CK7','P53','PD-L1','ALK','HER2','CD20','S-100'],
    'cheap':     ['Ki-67','CK7','Vimentin','AFP','EMA','CD3'],
    'mid':       ['Ki-67','CK7','CK20','CD20','Desmin','P53','S-100'],
    'molecular': ['Ki-67','PD-L1','ALK','GPNMB','TROP-2','PD-1','HER2'],  # 大量缺价
}
HOSPITALS = {
    'A_大三甲代送': dict(cases=400, ihc=(3,8), pool='expensive', ss=0.15),
    'B_县医院':     dict(cases=250, ihc=(1,3), pool='cheap',     ss=0.05),
    'C_专科特染':   dict(cases=180, ihc=(1,4), pool='mid',       ss=0.45),
    'D_小客户分子': dict(cases=60,  ihc=(2,6), pool='molecular', ss=0.10),
}
MONTHS = ['3月','4月','5月']

# ========== 5. 生成一个季度的真实病例明细 ==========
def gen_cases():
    rows = []  # 每行 = 一个病例
    for hname, h in HOSPITALS.items():
        pool = POOLS[h['pool']]
        for m in MONTHS:
            for _ in range(h['cases']):
                n_ihc = random.randint(*h['ihc'])
                abs_used = [random.choice(pool) for _ in range(n_ihc)]
                n_ss = 1 if random.random() < h['ss'] else 0
                rows.append(dict(hosp=hname, month=m, ihc=abs_used, ss=n_ss))
    return rows

CASES = gen_cases()

# ========== 6. 模型口径：贡献毛利 = 实收 − 可避免变动成本 ==========
def model_view(cases):
    agg = {}  # hosp -> dict
    ab_slide_count = {}  # 抗体 -> 全实验室片数(供采购模拟)
    for c in cases:
        a = agg.setdefault(c['hosp'], dict(cases=0, ihc_slides=0, ss_slides=0,
                                           rev=0.0, var=0.0, missing_slides=0))
        a['cases'] += 1
        # 收入
        rev = REV_HE + len(c['ihc'])*REV_IHC + c['ss']*REV_SS
        # 变动成本(模型)：一抗约定价 + 二抗显色 + 特染 + HE耗材
        var = HE_VAR + c['ss']*(REV_SS*0 + SS_VAR)
        for ab in c['ihc']:
            ab_slide_count[ab] = ab_slide_count.get(ab, 0) + 1
            price = LEDGER.get(ab)
            if price is None:           # 缺价 → 只能算二抗，一抗漏掉
                a['missing_slides'] += 1
                var += SECONDARY_VAR
            else:
                var += price + SECONDARY_VAR
        a['ihc_slides'] += len(c['ihc'])
        a['ss_slides']  += c['ss']
        a['rev'] += rev
        a['var'] += var
    for h,a in agg.items():
        a['cm'] = a['rev'] - a['var']              # 贡献毛利
        a['cm_rate'] = a['cm']/a['rev'] if a['rev'] else 0
    return agg, ab_slide_count

# ========== 7. 还原真实采购行为（大宗囤货 + 批次涨价 + 收得率波动 + 损耗） ==========
def real_purchase(ab_slide_count):
    """给定全季度各抗体真实片数，还原'为供应这些片，实际买了多少瓶、花了多少钱'。"""
    BOTTLE_TESTS_NOMINAL = 300      # 标称一瓶做300片(约定换算率用的)
    total_real_cash = 0.0
    total_model_cost = 0.0
    per_ab = []
    for ab, slides in sorted(ab_slide_count.items(), key=lambda x:-x[1]):
        price = LEDGER.get(ab)
        # 约定"每片一抗价" = 台账值；缺价的按0(模型漏)
        model_per_slide = price if price is not None else 0.0
        model_cost = slides * model_per_slide
        # ---- 真实世界 ----
        # 真实收得率：一瓶实际做 240~310 片(损耗/开瓶浪费/过期)，不是标称300
        real_yield = random.randint(240, 310)
        # 真实瓶价：台账价*300=名义瓶价，但真实采购分批、批次涨价 5%~25%、有起订量囤货
        nominal_bottle = (price if price is not None else 8.0) * BOTTLE_TESTS_NOMINAL
        bottles_needed = max(1, -(-slides // real_yield))   # ceil
        # 大宗囤货：常一次多买1瓶(起订/备货) → 期末有余量(这季度没摊完)
        bottles_bought = bottles_needed + (1 if slides > 0 else 0)
        # 批次均价漂移
        batch_price = nominal_bottle * random.uniform(1.05, 1.25)
        real_cash = bottles_bought * batch_price
        # 但"这季度真正耗用"的现金 = 已用片数对应 = bottles_needed部分(近似)
        real_cash_consumed = (slides/ (bottles_needed*real_yield)) * (bottles_needed*batch_price) if bottles_needed else 0
        total_real_cash += real_cash
        total_model_cost += model_cost
        per_ab.append(dict(ab=ab, slides=slides, model_per=model_per_slide,
                           real_yield=real_yield, batch_price=round(batch_price,1),
                           model_cost=round(model_cost,1),
                           real_cash_bought=round(real_cash,1),
                           real_cash_consumed=round(real_cash_consumed,1)))
    return total_model_cost, total_real_cash, per_ab

# ========== 8. 反面对照：若"错误地"把固定成本自上而下按抗体价加权摊到院 ==========
def wrong_topdown_allocation(agg):
    # 权重 = 各院"一抗约定价总额"(=材料变动里的抗体部分)占比
    weight = {}
    for h,a in agg.items():
        # 用抗体材料额当权重(提案原版的错法)
        weight[h] = a['var']  # 近似：变动成本额当权重
    tot_w = sum(weight.values())
    out = {}
    for h,a in agg.items():
        alloc_fixed = FIXED_COST_QUARTER * weight[h]/tot_w
        full_profit = a['cm'] - alloc_fixed
        out[h] = dict(alloc_fixed=alloc_fixed, full_profit=full_profit)
    return out

# ========== 9. 覆盖率漏例：B院 LIS 认不出 25% 病例 ==========
def coverage_gap(cases, hosp='B_县医院', drop=0.25):
    kept = [c for c in cases if not (c['hosp']==hosp and random.random()<drop)]
    return kept

# =============== 跑 ===============
def money(x): return f"¥{x:,.0f}"

agg, ab_count = model_view(CASES)
model_cost, real_cash, per_ab = real_purchase(ab_count)
wrong = wrong_topdown_allocation(agg)

print("="*78)
print("【A】模型口径：各院 贡献毛利 = 实收 − 可避免变动成本（判去留用这个）")
print("="*78)
print(f"{'医院':<14}{'病例':>5}{'IHC片':>7}{'实收':>12}{'变动成本':>12}{'贡献毛利':>12}{'CM率':>7}{'缺价片':>7}")
tot=dict(rev=0,var=0,cm=0,cases=0)
for h,a in sorted(agg.items(), key=lambda x:-x[1]['cm']):
    print(f"{h:<14}{a['cases']:>5}{a['ihc_slides']:>7}{money(a['rev']):>12}{money(a['var']):>12}{money(a['cm']):>12}{a['cm_rate']*100:>6.0f}%{a['missing_slides']:>7}")
    for k in ('rev','var','cm','cases'): tot[k]+=a[k]
print(f"{'合计':<14}{tot['cases']:>5}{'':>7}{money(tot['rev']):>12}{money(tot['var']):>12}{money(tot['cm']):>12}")
print(f"\n季度固定成本(财务给) = {money(FIXED_COST_QUARTER)}")
print(f"Σ各院贡献毛利 = {money(tot['cm'])}  →  {'覆盖得住固定成本，整体盈利' if tot['cm']>FIXED_COST_QUARTER else '覆盖不住！整体亏损'}  (差额 {money(tot['cm']-FIXED_COST_QUARTER)})")

print("\n"+"="*78)
print("【B】漏洞1：模型变动成本(约定价×片数) vs 真实采购现金(批次价×瓶数)")
print("="*78)
print(f"模型算的一抗材料成本  = {money(model_cost)}")
print(f"真实采购花的现金(含囤货)= {money(real_cash)}")
print(f"差额 = {money(real_cash-model_cost)}  ({(real_cash/model_cost-1)*100:+.0f}%)  ← 约定价系统性偏离真实采购的幅度")
print("最大偏离的几个抗体(真实收得率/批次涨价把约定价甩开)：")
print(f"  {'抗体':<10}{'片数':>6}{'约定/片':>9}{'真收得率':>9}{'模型成本':>11}{'真实购入':>11}")
for r in sorted(per_ab, key=lambda x:-(x['real_cash_bought']-x['model_cost']))[:6]:
    print(f"  {r['ab']:<10}{r['slides']:>6}{r['model_per']:>9}{r['real_yield']:>9}{money(r['model_cost']):>11}{money(r['real_cash_bought']):>11}")

print("\n"+"="*78)
print("【C】漏洞2：缺价抗体 → 哪家医院的变动成本被系统性低估(贡献毛利被高估)")
print("="*78)
for h,a in sorted(agg.items(), key=lambda x:-x[1]['missing_slides']):
    pct = a['missing_slides']/a['ihc_slides']*100 if a['ihc_slides'] else 0
    print(f"  {h:<14} 缺价片 {a['missing_slides']:>4} / IHC {a['ihc_slides']:>5} ({pct:>4.0f}%)  → 该院一抗成本漏算、CM虚高")

print("\n"+"="*78)
print("【D】漏洞3(致命对照)：若错误地把固定成本按抗体价加权摊到院 → 排名反转/死亡螺旋")
print("="*78)
print(f"  {'医院':<14}{'贡献毛利排名':>12}{'摊固定成本':>12}{'全成本盈亏':>12}  {'结论'}")
cm_rank = {h:i+1 for i,(h,_) in enumerate(sorted(agg.items(), key=lambda x:-x[1]['cm']))}
for h,a in sorted(agg.items(), key=lambda x:-wrong[h]['full_profit']):
    w = wrong[h]
    flag = '⚠翻成亏损' if w['full_profit']<0<a['cm'] else ''
    print(f"  {h:<14}{('第'+str(cm_rank[h])):>12}{money(w['alloc_fixed']):>12}{money(w['full_profit']):>12}  {flag}")
print("  → 贡献毛利为正的院，被摊完固定成本后可能翻成'亏损'；按此砍院=死亡螺旋。")

print("\n"+"="*78)
print("【E】漏洞4：覆盖率漏例(B院LIS认不出25%) → 院际对比失真")
print("="*78)
kept = coverage_gap(CASES)
agg2,_ = model_view(kept)
for h in ['B_县医院']:
    before, after = agg[h], agg2[h]
    print(f"  {h}: 病例 {before['cases']}→{after['cases']}  贡献毛利 {money(before['cm'])}→{money(after['cm'])}")
    print(f"    每例CM {money(before['cm']/before['cases'])} vs {money(after['cm']/after['cases'])} (每例稳，但院总额少算 {money(before['cm']-after['cm'])})")
