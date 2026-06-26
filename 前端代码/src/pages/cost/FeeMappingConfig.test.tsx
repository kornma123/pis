import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { abcApi } from '@/api/abc'
import FeeMappingConfig from './FeeMappingConfig'

vi.mock('@/api/abc', () => ({
  abcApi: {
    getBomFeeMappingAudit: vi.fn(),
    runBomFeeMappingAudit: vi.fn(),
    getBomFeeMappings: vi.fn(),
    updateBomFeeMappings: vi.fn(),
    previewBomFeeMapping: vi.fn(),
    getFeeStandards: vi.fn(),
  },
}))

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
  },
}))

describe('FeeMappingConfig', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    window.history.replaceState(null, '', '/')
    vi.mocked(abcApi.getFeeStandards).mockResolvedValue([])
    vi.mocked(abcApi.getBomFeeMappingAudit).mockResolvedValue({
      list: [{
        bomId: 'BOM-PW-FEE-DEEP-001',
        bomCode: 'BOM-PW-FEE-DEEP-001',
        bomName: '深链验证收费映射BOM',
        bomType: 'ihc',
        status: 'mapped',
        mappingCount: 1,
        mappedFeeNames: ['IHC染色检查费'],
      }],
      pagination: { total: 1 },
      summary: { total: 1, mapped: 1, legacy: 0, missing: 0 },
    } as any)
  })

  it('uses keyword from URL so audit links open a filtered fee mapping list', async () => {
    window.history.replaceState(null, '', '/abc/fee-mappings?keyword=BOM-PW-FEE-DEEP-001')

    render(<FeeMappingConfig />)

    await waitFor(() => expect(abcApi.getBomFeeMappingAudit).toHaveBeenCalledWith(expect.objectContaining({
      keyword: 'BOM-PW-FEE-DEEP-001',
      status: undefined,
      page: 1,
      pageSize: 10,
    })))
    expect(screen.getByPlaceholderText('BOM名称 / 编号')).toHaveValue('BOM-PW-FEE-DEEP-001')
    expect(await screen.findByText('深链验证收费映射BOM')).toBeInTheDocument()
    expect(screen.getByText('IHC染色检查费')).toBeInTheDocument()
  })

  it('uses status from URL so missing mapping links keep users on unmapped BOMs', async () => {
    window.history.replaceState(null, '', '/abc/fee-mappings?keyword=BOM-PW-FEE-DEEP-001&status=missing')

    render(<FeeMappingConfig />)

    await waitFor(() => expect(abcApi.getBomFeeMappingAudit).toHaveBeenCalledWith(expect.objectContaining({
      keyword: 'BOM-PW-FEE-DEEP-001',
      status: 'missing',
      page: 1,
      pageSize: 10,
    })))
    expect(screen.getByPlaceholderText('BOM名称 / 编号')).toHaveValue('BOM-PW-FEE-DEEP-001')
    expect(screen.getByLabelText('配置状态')).toHaveValue('missing')
  })

  it('opens the saved mapping in the configured list after fixing a missing BOM mapping', async () => {
    const missingRow = {
      bomId: 'bom-fee-001',
      bomCode: 'BOM-FEE-001',
      bomName: '术中快速收费BOM',
      bomType: 'ihc',
      status: 'missing',
      mappingCount: 0,
      mappedFeeNames: [],
      exceptionNo: 'EXP-FEE-001',
    }
    const mappedRow = {
      ...missingRow,
      status: 'mapped',
      mappingCount: 1,
      mappedFeeNames: ['IHC染色检查费'],
      exceptionNo: undefined,
    }
    vi.mocked(abcApi.getFeeStandards).mockResolvedValue({
      list: [{ id: 'fee-ihc', code: 'FEE-IHC', name: 'IHC染色检查费' }],
    } as any)
    vi.mocked(abcApi.getBomFeeMappingAudit)
      .mockResolvedValueOnce({
        list: [missingRow],
        pagination: { total: 1 },
        summary: { total: 1, mapped: 0, legacy: 0, missing: 1 },
      } as any)
      .mockResolvedValueOnce({
        list: [missingRow],
        pagination: { total: 1 },
        summary: { total: 1, mapped: 0, legacy: 0, missing: 1 },
      } as any)
      .mockResolvedValueOnce({
        list: [mappedRow],
        pagination: { total: 1 },
        summary: { total: 1, mapped: 1, legacy: 0, missing: 0 },
      } as any)
    vi.mocked(abcApi.getBomFeeMappings).mockResolvedValue([])
    vi.mocked(abcApi.updateBomFeeMappings).mockResolvedValue({} as any)

    render(<FeeMappingConfig />)

    expect(await screen.findByText('术中快速收费BOM')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('配置状态'), { target: { value: 'missing' } })
    await waitFor(() => expect(abcApi.getBomFeeMappingAudit).toHaveBeenCalledWith(expect.objectContaining({
      status: 'missing',
    })))
    fireEvent.click(screen.getByRole('button', { name: /配置/ }))
    await screen.findByText('配置收费映射')
    fireEvent.change(screen.getByDisplayValue('选择收费标准'), { target: { value: 'fee-ihc' } })
    expect(screen.getByText('收费映射结果确认')).toBeInTheDocument()
    expect(screen.getByText('确认后将接住：BOM、收费标准、病例收费、成本对比、异常预警、审计记录')).toBeInTheDocument()
    expect(screen.getByText('BOM 术中快速收费BOM')).toBeInTheDocument()
    expect(screen.getByText('映射 IHC染色检查费 (FEE-IHC) × 1 · 按出库单')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '保存映射' }))

    await waitFor(() => expect(abcApi.updateBomFeeMappings).toHaveBeenCalledWith('bom-fee-001', [{
      feeStandardId: 'fee-ihc',
      quantityMultiplier: 1,
      aggregationScope: 'outbound',
    }]))
    await waitFor(() => expect(abcApi.getBomFeeMappingAudit).toHaveBeenLastCalledWith(expect.objectContaining({
      keyword: 'BOM-FEE-001',
      status: 'mapped',
      page: 1,
      pageSize: 10,
    })))
    expect(screen.getByPlaceholderText('BOM名称 / 编号')).toHaveValue('BOM-FEE-001')
    expect(screen.getByLabelText('配置状态')).toHaveValue('mapped')
    expect(await screen.findByText('IHC染色检查费')).toBeInTheDocument()
  })

  it('blocks saving a mapping when quantity multiplier is not positive', async () => {
    vi.mocked(abcApi.getFeeStandards).mockResolvedValue({
      list: [{ id: 'fee-ihc', code: 'FEE-IHC', name: 'IHC染色检查费' }],
    } as any)
    vi.mocked(abcApi.getBomFeeMappingAudit).mockResolvedValue({
      list: [{
        bomId: 'bom-fee-001',
        bomCode: 'BOM-FEE-001',
        bomName: '术中快速收费BOM',
        bomType: 'ihc',
        status: 'missing',
        mappingCount: 0,
        mappedFeeNames: [],
        exceptionNo: 'EXP-FEE-001',
      }],
      pagination: { total: 1 },
      summary: { total: 1, mapped: 0, legacy: 0, missing: 1 },
    } as any)
    vi.mocked(abcApi.getBomFeeMappings).mockResolvedValue([])

    render(<FeeMappingConfig />)

    expect(await screen.findByText('术中快速收费BOM')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /配置/ }))
    await screen.findByText('配置收费映射')
    fireEvent.change(screen.getByDisplayValue('选择收费标准'), { target: { value: 'fee-ihc' } })
    fireEvent.change(screen.getByLabelText('数量系数'), { target: { value: '-1' } })

    expect(screen.getByText('请填写大于 0 的数量系数，系统才能正确计算病例收费、成本对比和预警。')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '保存映射' })).toBeDisabled()
    expect(abcApi.updateBomFeeMappings).not.toHaveBeenCalled()
  })
})
