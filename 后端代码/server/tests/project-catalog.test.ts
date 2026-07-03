/**
 * 统一检测项目目录（project-catalog）单测 —— D2 地基线 D。
 *
 * 契约：四套/五套叫法都能查到「同一个标准项」；变体归一；复合行拆包带数量；
 *   噪音自动剔除进待校对队列；未命中不抛错只返回 matched:false；种子幂等。
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { getDb } from './p0-harness.js'
import {
  seedProjectCatalog, syncProjectCodeMappings, lookupProject, classifyStatementItem,
  aggregateComponents, parseComponentQty, normalizeAlias, listCatalog, listReviewQueue,
  catalogSummary, getAliasesForCatalog, PROJECT_CATALOG_SEED, IHC_MARKER_SEED,
} from '../src/utils/project-catalog.js'

let db: any

beforeAll(async () => {
  db = await getDb() // initializeDatabase() 内已调用 seedProjectCatalog
})

describe('project_catalog：标准项种子', () => {
  it('标准项已建，含核心 PC-* 条目', () => {
    const codes = new Set(listCatalog(db).map((c) => c.canonicalCode))
    for (const need of ['PC-IHC-STD', 'PC-DIAG-STD', 'PC-SS', 'PC-ISH', 'PC-TCT', 'PC-SPECIMEN-DIAG', 'PC-CONSULT']) {
      expect(codes.has(need)).toBe(true)
    }
    expect(listCatalog(db).length).toBe(PROJECT_CATALOG_SEED.length)
  })
})

describe('lookupProject：按四套叫法查同一标准项', () => {
  it('国标码 012100000120000 → PC-IHC-STD（exact/high）', () => {
    const r = lookupProject(db, '012100000120000', 'guobiao_code')
    expect(r.matched).toBe(true)
    expect(r.catalog?.canonicalCode).toBe('PC-IHC-STD')
    expect(r.components?.[0].confidence).toBe('high')
  })

  it('LIS 数量列「免疫组化数」→ PC-IHC-STD', () => {
    expect(lookupProject(db, '免疫组化数', 'lis_name').catalog?.canonicalCode).toBe('PC-IHC-STD')
  })

  it('LIS 抗体 markerName「Ki67」→ PC-IHC-STD', () => {
    expect(lookupProject(db, 'Ki67', 'lis_name').catalog?.canonicalCode).toBe('PC-IHC-STD')
  })

  it('对账单名「妇科TCT检测」→ PC-TCT', () => {
    expect(lookupProject(db, '妇科TCT检测', 'statement_item').catalog?.canonicalCode).toBe('PC-TCT')
  })

  it('⭐ D2 核心：四套叫法（国标/LIS/对账单/系统项目码）全部指向同一个 PC-IHC-STD', () => {
    // 插入一个 ihc 类型的系统项目，同步 project_code 映射
    db.prepare(`INSERT OR IGNORE INTO projects (id, code, name, type, status, is_deleted) VALUES (?, ?, ?, ?, 1, 0)`)
      .run('TP-IHC', 'TEST-IHC-1', '测试免疫组化项目', 'ihc')
    syncProjectCodeMappings(db)

    const byGuobiao = lookupProject(db, '012100000120000', 'guobiao_code').catalog?.canonicalCode
    const byLis = lookupProject(db, '免疫组化数', 'lis_name').catalog?.canonicalCode
    const byStatement = lookupProject(db, '免疫组化检测（前八项）', 'statement_item').catalog?.canonicalCode
    const byProjectCode = lookupProject(db, 'TEST-IHC-1', 'project_code').catalog?.canonicalCode
    expect([byGuobiao, byLis, byStatement, byProjectCode]).toEqual(['PC-IHC-STD', 'PC-IHC-STD', 'PC-IHC-STD', 'PC-IHC-STD'])
  })
})

describe('归一化：全角/半角/大小写变体归一到同一项', () => {
  it('手术标本（全角括号）与 (半角括号) 都 → PC-SPECIMEN-DIAG', () => {
    const a = lookupProject(db, '手术标本检查与诊断（小标本）', 'statement_item').catalog?.canonicalCode
    const b = lookupProject(db, '手术标本检查与诊断(小标本)', 'statement_item').catalog?.canonicalCode
    expect(a).toBe('PC-SPECIMEN-DIAG')
    expect(b).toBe('PC-SPECIMEN-DIAG')
  })
  it('normalizeAlias 折叠全角/空白/大小写', () => {
    expect(normalizeAlias('ＨＰＶ  ')).toBe('hpv')
    expect(normalizeAlias('（小标本）')).toBe('(小标本)')
  })
})

describe('拆包：复合行 + 数量解析', () => {
  it('parseComponentQty：前八项=8 / *16=16 / x20=20', () => {
    expect(parseComponentQty('免疫组化检测（前八项）')).toBe(8)
    expect(parseComponentQty('免疫组化*16')).toBe(16)
    expect(parseComponentQty('病理癌基因蛋白检测182x20')).toBe(20)
  })

  it('免疫组化*16 → PC-IHC-STD 且 componentQty=16', () => {
    const r = lookupProject(db, '免疫组化*16', 'statement_item')
    expect(r.matched).toBe(true)
    expect(r.components?.[0].catalogCode).toBe('PC-IHC-STD')
    expect(r.components?.[0].componentQty).toBe(16)
  })

  it('混合行「真项目、水费」逐段判：真项目段保留，噪音段单独标 noise（不整行丢失）', () => {
    const comps = classifyStatementItem('手术标本检查与诊断、水费')
    expect(comps.length).toBe(2)
    expect(comps[0].catalogCode).toBe('PC-SPECIMEN-DIAG')
    expect(comps[1].catalogCode).toBe('')
    expect(comps[1].reason).toBe('noise')
    // lookup 该混合行仍算命中（有真项目段）
    expect(lookupProject(db, '手术标本检查与诊断、水费', 'statement_item').matched).toBe(true)
  })

  it('复合行「癌基因蛋白、单克隆抗体、疑难会诊」拆成 3 段', () => {
    const comps = classifyStatementItem('病理癌基因蛋白检测182x10、病理单克隆抗体检测147x6、疑难病理会诊（市外）182')
    expect(comps.length).toBe(3)
    expect(comps.map((c) => c.catalogCode)).toEqual(['PC-IHC-STD', 'PC-IHC-STD', 'PC-CONSULT'])
    expect(comps[0].componentQty).toBe(10)
    expect(comps[1].componentQty).toBe(6)
    // 复合行每段都进待校对
    expect(comps.every((c) => c.reviewStatus === 'needs_review')).toBe(true)
  })

  it('⚠️ 聚合：同标准项多段合并、数量相加（癌基因蛋白10 + 单克隆抗体6 = IHC 16），不丢分量', () => {
    const agg = aggregateComponents(classifyStatementItem('病理癌基因蛋白检测182x10、病理单克隆抗体检测147x6、疑难病理会诊（市外）182'))
    expect(agg.length).toBe(2)
    expect(agg.find((c) => c.catalogCode === 'PC-IHC-STD')?.componentQty).toBe(16)
    expect(agg.find((c) => c.catalogCode === 'PC-CONSULT')).toBeTruthy()
  })

  it('⚠️ 入库/查询与聚合一致：种子该复合行 → PC-IHC-STD qty=16（UNIQUE 键不再顶掉同项分量）', () => {
    const r = lookupProject(db, '病理癌基因蛋白检测182x10、病理单克隆抗体检测147x6、疑难病理会诊（市外）182', 'statement_item')
    expect(r.matched).toBe(true)
    expect(r.components?.find((c) => c.catalogCode === 'PC-IHC-STD')?.componentQty).toBe(16)
  })
})

describe('id 唯一性：同标准项多别名互不顶掉（uuid id，非哈希碰撞）', () => {
  it('所有 IHC 抗体 markerName 别名都入库（无 id 碰撞丢行）', () => {
    const lisIhc = getAliasesForCatalog(db, 'PC-IHC-STD').filter((a) => a.system === 'lis_name')
    expect(lisIhc.length).toBeGreaterThanOrEqual(IHC_MARKER_SEED.length)
  })
})

describe('兜底：噪音 / 未命中，绝不抛错', () => {
  it('噪音「水费」→ matched:false, reason=noise', () => {
    const r = lookupProject(db, '水费', 'statement_item')
    expect(r.matched).toBe(false)
    expect(r.reason).toBe('noise')
  })

  it('完全未知 → matched:false, reason=no_mapping（不抛错）', () => {
    expect(() => lookupProject(db, 'zzz-完全没见过的-xyz', 'statement_item')).not.toThrow()
    const r = lookupProject(db, 'zzz-完全没见过的-xyz', 'statement_item')
    expect(r.matched).toBe(false)
    expect(r.reason).toBe('no_mapping')
  })

  it('含义未确认的 adviceType Y000006 → 未映射（进待校对，不臆断）', () => {
    expect(lookupProject(db, 'Y000006', 'lis_advice_type').matched).toBe(false)
  })
})

describe('待校对只读清单 + 概览', () => {
  it('review queue 非空，含噪音行与低置信行', () => {
    const q = listReviewQueue(db)
    expect(q.length).toBeGreaterThan(0)
    expect(q.some((r) => (r.note ?? '').includes('非项目'))).toBe(true)
  })

  it('catalogSummary 计数合理', () => {
    const s = catalogSummary(db)
    expect(s.catalogCount).toBe(PROJECT_CATALOG_SEED.length)
    expect(s.mappingCount).toBeGreaterThan(50)
    expect(s.unmapped).toBeGreaterThan(0)
  })

  it('反查：PC-IHC-STD 有多套叫法的别名', () => {
    const aliases = getAliasesForCatalog(db, 'PC-IHC-STD')
    const systems = new Set(aliases.map((a) => a.system))
    expect(systems.has('guobiao_code')).toBe(true)
    expect(systems.has('lis_name')).toBe(true)
    expect(systems.has('statement_item')).toBe(true)
  })
})

describe('健壮性：任意输入不抛错', () => {
  it('null / 空串 / 超长 / 正则特殊字符 / emoji 都不抛错且 matched:false', () => {
    const weird = ['', '   ', null as any, undefined as any, '(((*+[\\d]?', '🧫🔬', 'a'.repeat(5000)]
    for (const w of weird) {
      expect(() => lookupProject(db, w, 'statement_item')).not.toThrow()
      expect(lookupProject(db, w).matched).toBe(false)
    }
  })
})

describe('分类器规则顺序：易混项不误判', () => {
  const cc = (s: string) => classifyStatementItem(s)[0].catalogCode
  it('免疫组织化学染色诊断 → PC-IHC-STD（不被特染吃）', () => expect(cc('免疫组织化学染色诊断')).toBe('PC-IHC-STD'))
  it('荧光染色体原位杂交检查（FISH）→ PC-FISH（先于原位杂交）', () => expect(cc('荧光染色体原位杂交检查（FISH）')).toBe('PC-FISH'))
  it('远程病理会诊 → PC-DIAG-REMOTE（先于会诊）', () => expect(cc('远程病理会诊')).toBe('PC-DIAG-REMOTE'))
  it('PD-L1 → PC-IHC-ENH（先于免疫组化常规）', () => expect(cc('PD-L1')).toBe('PC-IHC-ENH'))
  it('特殊染色 → PC-SS', () => expect(cc('特殊染色-刚果红')).toBe('PC-SS'))
  // 分子（真数据驱动补的规则）
  it('人类K-RAS基因突变检测 → PC-MOL-GENE', () => expect(cc('人类K-RAS基因突变检测1700')).toBe('PC-MOL-GENE'))
  it('EML4-ALK 融合基因 → PC-MOL-GENE', () => expect(cc('人类检测EML4-ALK融合基因2137')).toBe('PC-MOL-GENE'))
  it('BRCA1/2 不被斜杠拆碎，整体 → PC-MOL-GENE', () => {
    const comps = classifyStatementItem('BRCA1/2基因检测')
    expect(comps.length).toBe(1)
    expect(comps[0].catalogCode).toBe('PC-MOL-GENE')
  })
  it('⚠️ 守卫：癌基因蛋白检测仍是 IHC（含"基因"但非分子基因检测）', () => {
    expect(cc('病理癌基因蛋白检测182x20')).toBe('PC-IHC-STD')
  })
  it('免疫细胞化学 → PC-IHC-STD', () => expect(cc('P16免疫细胞化学染色诊断')).toBe('PC-IHC-STD'))
  // 白片=空白/复制片，须优先于 IHC/特染 命中 PC-SLIDE-COPY，且与 LIS_TECH_ROW_SEED 口径一致
  it('免组白片 → PC-SLIDE-COPY（不被"免组"误吃成 IHC）', () => expect(cc('免组白片')).toBe('PC-SLIDE-COPY'))
  it('特染白片 → PC-SLIDE-COPY（不被"特染"误吃成特染）', () => expect(cc('特染白片')).toBe('PC-SLIDE-COPY'))
  it('免组白片 两条路径口径一致：statement 分类 = lis_name 种子 = PC-SLIDE-COPY', () => {
    expect(cc('免组白片')).toBe('PC-SLIDE-COPY')
    expect(lookupProject(db, '免疫组化白片', 'lis_name').catalog?.canonicalCode).toBe('PC-SLIDE-COPY')
  })
  it('远程会诊服务费 → PC-DIAG-REMOTE（"服务费"不再误剔为噪音）', () => expect(cc('远程会诊服务费')).toBe('PC-DIAG-REMOTE'))
  it('财务噪音「差旅费」→ 未映射(noise)', () => {
    expect(lookupProject(db, '差旅费', 'statement_item').reason).toBe('noise')
  })
})

describe('种子幂等', () => {
  it('重复 seedProjectCatalog 不产生重复行', () => {
    const before = catalogSummary(db).mappingCount
    seedProjectCatalog(db)
    seedProjectCatalog(db)
    expect(catalogSummary(db).mappingCount).toBe(before)
  })
})
