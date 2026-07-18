import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const frontendRoot = process.cwd()

function readSource(relativePath: string) {
  return readFileSync(resolve(frontendRoot, relativePath), 'utf8')
}

describe('project/BOM fake entry removal contract', () => {
  const projectPage = readSource('src/pages/master/Projects.tsx')
  const projectHook = readSource('src/pages/master/hooks/useProjectsPage.ts')
  const bomPage = readSource('src/pages/bom/BOM.tsx')
  const bomHook = readSource('src/pages/bom/hooks/useBOMPage.ts')
  const productionSurface = [projectPage, projectHook, bomPage, bomHook].join('\n')

  it('removes all three fake entries, their modal state, shells, and development copy', () => {
    expect(productionSurface).not.toMatch(/\b(?:ProjectImportModal|BOMImportModal|BOMExportModal)\b/)
    expect(productionSurface).not.toMatch(/setModalType\(['"](?:import|export)['"]\)/)
    expect(productionSurface).not.toMatch(/\|\s*['"](?:import|export)['"]/)
    expect(productionSurface).not.toMatch(/\bhandle(?:Import|Export)\b/)
    expect(productionSurface).not.toMatch(/(?:导入|导出)功能开发中/)
    expect(productionSurface).not.toMatch(/下载导入模板/)
    expect(projectPage).not.toMatch(/>\s*导入\s*</)
    expect(bomPage).not.toMatch(/>\s*(?:导入|导出)\s*</)
    expect(projectPage).not.toMatch(/\bUpload\b/)
    expect(bomPage).not.toMatch(/\b(?:Upload|Download)\b/)

    for (const shell of [
      'src/pages/master/components/ProjectImportModal.tsx',
      'src/pages/bom/components/BOMImportModal.tsx',
      'src/pages/bom/components/BOMExportModal.tsx',
    ]) {
      expect(existsSync(resolve(frontendRoot, shell)), `${shell} must stay deleted`).toBe(false)
    }
  })

  it('keeps the project create, read/list, edit, copy, and delete paths wired', () => {
    expect(projectPage).toMatch(/onClick=\{page\.openCreate\}/)
    expect(projectPage).toContain('<ProjectTable')
    for (const modal of ['Create', 'Edit', 'Copy', 'Delete']) {
      expect(projectPage).toContain(`<Project${modal}Modal`)
    }
    for (const wiring of [
      'onOpenEdit={page.openEdit}',
      'onOpenCopy={page.openCopy}',
      'onOpenDelete={page.openDelete}',
      'onSubmit={page.handleSubmit}',
      'onConfirm={page.handleSubmit}',
      'onConfirm={page.handleDeleteConfirm}',
    ]) {
      expect(projectPage).toContain(wiring)
    }
    for (const handler of ['openCreate', 'openEdit', 'openCopy', 'openDelete']) {
      expect(projectHook).toMatch(new RegExp(`\\bconst ${handler} =`))
    }
    expect(projectHook).toContain('projectApi.getList')
    expect(projectHook).toContain('await projectApi.create')
    expect(projectHook).toContain('await projectApi.update')
    expect(projectHook).toContain('await projectApi.delete')
  })

  it('keeps BOM CRUD, immutable-version history, and reconciliation approval anchors wired', () => {
    const bomDetail = readSource('src/pages/bom/components/BOMDetailModal.tsx')
    const reconciliationHook = readSource('src/pages/reconciliation/hooks/useReconciliationPage.ts')
    const reconciliationLogList = readSource('src/pages/reconciliation/components/LogListTab.tsx')

    expect(bomPage).toMatch(/onClick=\{page\.openCreate\}/)
    expect(bomPage).toContain('<BOMTable')
    for (const modal of ['Form', 'Detail', 'Copy', 'Delete', 'BatchDelete']) {
      expect(bomPage).toContain(`<BOM${modal}Modal`)
    }
    for (const wiring of [
      'onOpenDetail={page.openDetail}',
      'onOpenEdit={page.openEdit}',
      'onOpenCopy={page.openCopy}',
      'onOpenDelete={page.openDelete}',
      'onBatchDelete={page.openBatchDelete}',
      'onSubmit={page.handleSubmit}',
      'onConfirm={page.handleCopy}',
      'onConfirm={page.handleDelete}',
      'onConfirm={page.handleBatchDelete}',
    ]) {
      expect(bomPage).toContain(wiring)
    }
    for (const handler of ['openCreate', 'openEdit', 'openDetail', 'openCopy', 'openDelete', 'openBatchDelete']) {
      expect(bomHook).toMatch(new RegExp(`\\bconst ${handler} =`))
    }
    expect(bomHook).toContain('bomApi.getList')
    expect(bomHook).toContain('bomApi.getDetail')
    expect(bomHook).toContain('await bomApi.create')
    expect(bomHook).toContain('await bomApi.update')
    expect(bomHook).toContain('await bomApi.delete')
    expect(bomHook).toContain("'info' | 'history' | 'usage'")
    expect(bomDetail).toContain('版本历史')
    expect(bomDetail).toContain('versionHistory')
    expect(reconciliationHook).toContain('/reconciliation/logs/${id}/approve')
    expect(reconciliationHook).toContain("'future_only' | 'retroactive'")
    expect(reconciliationLogList).toContain("onApprove(log.id, 'future_only')")
  })
})
