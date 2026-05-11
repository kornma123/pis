const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, '前端代码/src/pages/inventory/InventoryList.tsx');
const originalContent = fs.readFileSync(filePath, 'utf-8');
const lineEnding = originalContent.includes('\r\n') ? '\r\n' : '\n';
let lines = originalContent.split(/\r?\n/);

// 1. Add expandedGroups state after activeTab state (around line 70)
for (let i = 69; i < 76; i++) {
  if (lines[i] && lines[i].includes("const [activeTab, setActiveTab]")) {
    lines.splice(i + 1, 0, "  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set())");
    console.log(`Added expandedGroups state at line ${i + 2}`);
    break;
  }
}

// 2. Add groupedData useMemo after sortedData useMemo
// Find the end of sortedData useMemo
let sortedDataEnd = -1;
for (let i = 203; i < 240; i++) {
  if (lines[i] && lines[i].includes('}, [data, sortField, sortDirection])')) {
    sortedDataEnd = i;
    break;
  }
}

if (sortedDataEnd !== -1) {
  const groupCode = [
    '',
    '  // ===== 按物料名称分组 =====',
    '  const groupedData = useMemo(() => {',
    '    const groups: Record<string, InventoryRow[]> = {}',
    '    sortedData.forEach(item => {',
    '      if (!groups[item.name]) groups[item.name] = []',
    '      groups[item.name].push(item)',
    '    })',
    '    return groups',
    '  }, [sortedData])',
    '',
    '  const toggleGroup = (name: string) => {',
    '    setExpandedGroups(prev => {',
    '      const next = new Set(prev)',
    '      if (next.has(name)) next.delete(name)',
    '      else next.add(name)',
    '      return next',
    '    })',
    '  }',
  ];
  lines.splice(sortedDataEnd + 1, 0, ...groupCode);
  console.log(`Added groupedData useMemo at line ${sortedDataEnd + 2}`);
}

// 3. Replace table body rendering (lines ~817-873)
// Find the sortedData.map block
let mapStart = -1;
let mapEnd = -1;
for (let i = 815; i < 880; i++) {
  if (lines[i] && lines[i].trim() === 'sortedData.map(row => {') {
    mapStart = i;
  }
  if (mapStart !== -1 && lines[i] && lines[i].trim() === '})' && lines[i].startsWith('                ')) {
    mapEnd = i;
    break;
  }
}

if (mapStart !== -1 && mapEnd !== -1) {
  const newRender = [
    '                Object.entries(groupedData).map(([groupName, batches]) => {',
    '                  const isExpanded = expandedGroups.has(groupName)',
    '                  const first = batches[0]',
    '                  const totalStock = batches.reduce((sum, b) => sum + (b.stock || 0), 0)',
    '                  const groupStatusInfo = getStatusInfo({ stock: totalStock, minStock: first.minStock, expiry: first.expiry, status: first.status } as any)',
    '                  return (',
    '                    <React.Fragment key={groupName}>',
    '                      {/* 分组汇总行 */}',
    '                      <tr',
    '                        className="hover:bg-gray-50 transition-colors duration-150 cursor-pointer bg-gray-50/50"
    '                        onClick={() => toggleGroup(groupName)}',
    '                      >',
    '                        <td className="px-4 py-3">',
    '                          <input',
    '                            type="checkbox"',
    '                            className="w-4 h-4 rounded border-gray-300 text-[#3b82f6] focus:ring-[#3b82f6]"',
    '                            onChange={(e) => e.stopPropagation()}',
    '                          />',
    '                        </td>',
    '                        <td className="px-4 py-3">',
    '                          <div className="flex items-center gap-2">',
    '                            <span className={`transition-transform duration-200 ${isExpanded ? 'rotate-90' : ''}`}>',
    '                              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 18 15 12 9 6"></polyline></svg>',
    '                            </span>',
    '                            <div>',
    '                              <div className="font-semibold text-gray-900">{first.name}</div>',
    '                              <div className="text-xs text-gray-500 mt-0.5">{first.spec || ''}</div>',
    '                            </div>',
    '                          </div>',
    '                        </td>',
    '                        <td className="px-4 py-3">',
    '                          <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-blue-50 text-blue-700">',
    '                            {batches.length} 批次',
    '                          </span>',
    '                        </td>',
    '                        <td className="px-4 py-3 text-gray-600 text-sm">{first.locationName || first.locationId || \'-\'}</td>',
    '                        <td className="px-4 py-3">',
    '                          <span className="font-semibold text-gray-900">{totalStock}</span>',
    '                          <span className="text-xs text-green-500 ml-1">{totalStock >= (first.minStock || 0) ? \'充足\' : \'不足\'}</span>',
    '                        </td>',
    '                        <td className="px-4 py-3"></td>',
    '                        <td className="px-4 py-3"></td>',
    '                        <td className="px-4 py-3">',
    '                          <div className="flex items-center gap-2">',
    '                            <button onClick={(e) => { e.stopPropagation(); viewDetail(first) }} className="text-sm text-gray-600 hover:text-gray-900 transition-colors">详情</button>',
    '                            <button onClick={(e) => { e.stopPropagation(); openOutboundModal(first) }} className="text-sm text-[#3b82f6] hover:text-[#2563eb] transition-colors">出库</button>',
    '                          </div>',
    '                        </td>',
    '                      </tr>',
    '                      {/* 批次明细行 */}',
    '                      {isExpanded && batches.map(row => {',
    '                        const statusInfo = getStatusInfo(row)',
    '                        const isSelected = selectedIds.has(row.id)',
    '                        return (',
    '                          <tr',
    '                            key={row.id}',
    '                            className="hover:bg-gray-50 transition-colors duration-150"',
    '                          >',
    '                            <td className="px-4 py-3 pl-8">',
    '                              <input',
    '                                type="checkbox"',
    '                                checked={isSelected}',
    '                                onChange={() => toggleSelectOne(row.id)}',
    '                                className="w-4 h-4 rounded border-gray-300 text-[#3b82f6] focus:ring-[#3b82f6]"',
    '                              />',
    '                            </td>',
    '                            <td className="px-4 py-3 pl-12">',
    '                              <span className="text-gray-400 text-xs mr-1">└</span>',
    '                              <span className="font-medium text-gray-900">{row.name}</span>',
    '                            </td>',
    '                            <td className="px-4 py-3 font-mono text-gray-600 text-xs">{row.batch || \'-\'}</td>',
    '                            <td className="px-4 py-3 text-gray-600 text-sm">{row.locationName || row.locationId || \'-\'}</td>',
    '                            <td className="px-4 py-3">',
    '                              <span className="font-medium text-gray-900">{row.stock}</span>',
    '                              {getStockLevelIndicator(row)}',
    '                            </td>',
    '                            <td className="px-4 py-3">',
    '                              <span className="text-gray-600">{row.expiry || \'-\'}</span>',
    '                              {getExpiryTag(row)}',
    '                            </td>',
    '                            <td className="px-4 py-3">',
    '                              <span className={`inline-flex items-center rounded-full px-3 py-1 text-xs font-medium ${statusInfo.badgeClass}`}>',
    '                                {statusInfo.label}',
    '                              </span>',
    '                            </td>',
    '                            <td className="px-4 py-3">',
    '                              <div className="flex items-center gap-2">',
    '                                <button onClick={() => viewDetail(row)} className="text-sm text-gray-600 hover:text-gray-900 transition-colors">详情</button>',
    '                                <button onClick={() => openOutboundModal(row)} className="text-sm text-[#3b82f6] hover:text-[#2563eb] transition-colors">出库</button>',
    '                              </div>',
    '                            </td>',
    '                          </tr>',
    '                        )',
    '                      })}',
    '                    </React.Fragment>',
    '                  )',
    '                })',
  ];
  lines.splice(mapStart - 1, mapEnd - mapStart + 2, ...newRender);
  console.log(`Replaced table body rendering from line ${mapStart} to ${mapEnd}`);
}

fs.writeFileSync(filePath, lines.join(lineEnding), 'utf-8');
console.log('Done');
