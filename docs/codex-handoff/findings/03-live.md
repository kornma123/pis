# 段③ 前端交互/视觉实测发现

总体结论：4 个 P6 页面能在本地跑起来并完成基础导航，但关键验收链路仍未闭合：月度向导 409 确认门禁前后端契约不匹配，导入上传入口键盘不可达，看板下钻和配置页表单/Tab/Switch 语义不足；此外仓库随带 SQLite 并未包含提示词要求的 6 院种子数据，实测前需要人工补数据。

## CRITICAL

1. `前端代码/src/api/request.ts:132`、`前端代码/src/api/request.ts:136`、`前端代码/src/pages/import-wizard/ImportWizardPage.tsx:45`、`前端代码/src/pages/import-wizard/ImportWizardPage.tsx:46`、`后端代码/server/src/routes/statement-import-v1.1.ts:107`、`后端代码/server/src/routes/statement-import-v1.1.ts:111`
   页面：`/import-wizard`。
   违反项：Nielsen「帮助识别/诊断/恢复错误」、流程门禁、数据安全。
   为什么是 UX 问题：后端未确认入库时正确返回 HTTP 409，包体是 `{ error: { code: "NEEDS_CONFIRM", message } }`；但全局 axios 拦截器对非 2xx reject 原始 AxiosError，向导只检查顶层 `e.code/e.message`。实测最小网格 commit 返回 `STATUS=409` 和 `error.code="NEEDS_CONFIRM"`，前端却拿不到该 code，无法显示“确认入库（含未识别）”恢复按钮，财务会看到普通失败或被卡在入库前。
   复现步骤：登录 `caiwu`；打开 `/import-wizard`；后端发送 `{ partnerId:"PT-LIVE-1", serviceMonth:"2026-06", grid:[["病理号","项目名称","收费金额","结算扣率","结算金额"],["CASE-LIVE-409","无法识别测试项目",100,1,100]], confirm:false }` 到 `/api/v1/statement-import/commit`；观察 409 包体。截图：`shots/03-import-wizard-desktop.png`。
   具体修法：request 拦截器对所有业务错误统一 reject `{ status, code, message, raw }`，或向导 catch 读取 `e.response?.data?.error`；以 `status === 409 && code === 'NEEDS_CONFIRM'` 进入确认态；补 UI 单测覆盖 409 后按钮出现、再次提交带 `confirm:true`。

## HIGH

1. `后端代码/server/data/coreone.db`、`docs/codex-handoff/03-前端交互视觉实测-方案B.txt:12`
   页面：`/partner-config`、`/hospital-pnl`、两个导入页。
   违反项：验收环境前置、五态里的空态/正常态。
   为什么是 UX 问题：提示词声明随仓库 SQLite “含 6 院数据”，但实测启动后 `partners=0`、`partner_configs=0`、`case_revenue=0`，`/partner-config` 只显示 `暂无合作医院`，`/hospital-pnl` 和导入页无法走真实核心流程。为继续实测，我只在本地数据库手工补了 2 个 partner 和 2 条收入行；该数据库变更未纳入提交。
   复现步骤：新 clone 后启动后端和前端；用 `caiwu` 登录；打开 `/partner-config`。截图：`shots/03-partner-config-list-desktop.png` 是原始空态，`shots/03-partner-config-seeded-list-desktop.png` 是手工补数据后的列表。
   具体修法：把测试数据播种脚本纳入可重复启动流程，或修复仓库内 SQLite；前端空态需要区分“无权限/加载失败/未播种/真实无医院”，并给出管理员可执行的恢复入口。

2. `前端代码/src/pages/import-shared/ImportShared.tsx:50`、`前端代码/src/pages/import-shared/ImportShared.tsx:52`
   页面：`/import-console`、`/import-wizard`。
   违反项：WCAG 键盘可达、表单语义。
   为什么是 UX 问题：实测 DOM 中“上传对账单”是 `label` 包 `input[type=file]`，label 没有 `for/role/tabIndex`，file input 是 `display:none`。Tab 顺序不会停在上传入口，键盘用户无法上传文件，等于两个导入流程不可用。
   复现步骤：打开 `/import-console` 或 `/import-wizard`；检查 DOM 或只用 Tab 导航到上传区；上传按钮无法获得焦点。截图：`shots/03-import-console-desktop.png`、`shots/03-import-wizard-desktop.png`。
   具体修法：改成真实 `<button type="button">` 触发 input ref；input 用 visually-hidden 而不是 `display:none`，或给 label 补 `tabIndex=0`、Enter/Space、`aria-disabled` 和可见 focus ring。

3. `前端代码/src/pages/hospital-pnl/HospitalPnLDashboard.tsx:136`、`前端代码/src/pages/hospital-pnl/HospitalPnLDashboard.tsx:137`
   页面：`/hospital-pnl`。
   违反项：WCAG 键盘可达、识别优于回忆。
   为什么是 UX 问题：院级表提示“点上表某行切换医院”，实测鼠标点击第一行能把趋势切到“现场测试医院二号”，但行 DOM 是普通 `<tr>`，`cursor:pointer`、`role=null`、`tabIndex=-1`、无 `aria-label`。键盘用户无法触发看板下钻，也不会知道表格行可操作。
   复现步骤：打开 `/hospital-pnl`；点击第一行，趋势标题变为“月度趋势 · 现场测试医院二号”；检查行属性。截图：`shots/03-hospital-pnl-desktop.png`、`shots/03-hospital-pnl-row-click-desktop.png`、`shots/03-hospital-pnl-mobile.png`。
   具体修法：首列放真实按钮或链接，或给行补 `role="button" tabIndex={0}`、Enter/Space、`aria-label="查看{医院}趋势"` 和 focus ring；移动端表格横滚区也要保留焦点可见。

4. `前端代码/src/pages/partner-config/PartnerConfigPage.tsx:250`、`前端代码/src/pages/partner-config/PartnerConfigPage.tsx:221`、`前端代码/src/pages/partner-config/PartnerConfigPage.tsx:304`
   页面：`/partner-config` 详情页。
   违反项：WCAG 表单 label、ARIA Tabs/Switch、Nielsen 一致性。
   为什么是 UX 问题：详情页实测 `label` 数量为 0，输入框没有 `id/name/aria-label`；6 个“基本档案/业务分类/...”只是普通 button，没有 `tablist/tab/aria-selected/aria-controls`；业务线开关有 `role="switch"` 和 `aria-checked`，但没有可读名称。读屏用户无法知道当前字段、当前 Tab 或当前开关控制哪条业务线。
   复现步骤：打开 `/partner-config`，进入医院详情，切到“业务分类”；检查 DOM。截图：`shots/03-partner-config-detail-desktop.png`、`shots/03-partner-config-business-tab-desktop.png`。
   具体修法：`Field` 生成稳定 id 并渲染 `<label htmlFor>`；Tabs 使用 Radix Tabs 或补齐 WAI-ARIA tabs 模式和方向键 roving tabindex；switch 增加 `aria-label={`${业务线名}启用状态`}` 或和可见标题关联。

## MEDIUM

1. `前端代码/src/components/layout/AppSidebar.tsx:185`、`前端代码/src/components/layout/AppSidebar.tsx:239`、`前端代码/src/components/layout/AppSidebar.tsx:245`
   页面：共性布局，移动端尤甚。
   违反项：WCAG 非文本控件名称。
   为什么是 UX 问题：移动端侧边栏按钮只显示 `PanelLeft/PanelRight` 图标，实测按钮文本为空且无 `aria-label`；侧边栏折叠按钮只依赖 `title`。辅助技术用户无法知道这些按钮是打开/关闭菜单还是折叠侧栏。
   复现步骤：移动视口 390px 打开 `/partner-config` 或 `/hospital-pnl`；检查首个按钮，`text=""`、`aria=null`。截图：`shots/03-partner-config-mobile.png`、`shots/03-hospital-pnl-mobile.png`。
   具体修法：给移动按钮 `aria-label={mobileOpen ? '关闭导航菜单' : '打开导航菜单'}`；折叠按钮补 `aria-label` 和 `aria-expanded`；图标设 `aria-hidden`。

2. `前端代码/src/pages/partner-config/PartnerConfigPage.tsx:203`、`前端代码/src/pages/partner-config/PartnerConfigPage.tsx:210`、`前端代码/src/pages/partner-config/PartnerConfigPage.tsx:317`
   页面：`/partner-config`。
   违反项：用户可控、错误预防、项目标准“不用 prompt()/alert() 承载流程”。
   为什么是 UX 问题：源码仍用原生 `window.confirm` 承载返回、放弃、删除业务线等高风险动作。浏览器实测点击“返回列表/放弃改动”会停留在有未保存改动状态，插件没有拿到可样式化的应用内弹层；无论浏览器如何处理原生弹窗，该设计都无法提供影响说明、焦点管理、移动端一致样式和撤销策略。
   复现步骤：详情页修改“简称”，点击“返回列表”或“放弃改动”；页面保留“有未保存改动”。截图：`shots/03-partner-config-unsaved-confirm-desktop.png`。
   具体修法：使用项目 Modal/Radix AlertDialog；标题写明动作和影响范围，主次按钮清楚区分，Esc/焦点回收可控；删除业务线显示将删除的识别词和收入影响。

3. `前端代码/src/pages/hospital-pnl/HospitalPnLDashboard.tsx:74`、`前端代码/src/pages/hospital-pnl/HospitalPnLDashboard.tsx:114`、`前端代码/src/pages/hospital-pnl/HospitalPnLDashboard.tsx:162`、`前端代码/src/pages/hospital-pnl/HospitalPnLDashboard.tsx:186`
   页面：`/hospital-pnl`。
   违反项：plain-Chinese、识别优于回忆、数据诚实。
   为什么是 UX 问题：实测页面同时出现 `P&L`、`ABC 成本`、`benchmark 未病种校正`、`case`、`按医院上卷` 等黑话。财务用户需要理解收入/成本/毛利口径，黑话会增加解释成本；同时 `ABC 成本 ¥0 / 未接通` 需要明确是未接入成本而非真实零成本。
   复现步骤：打开 `/hospital-pnl`；查看 KPI、表头、说明区。截图：`shots/03-hospital-pnl-desktop.png`。
   具体修法：把标题和说明改成业务话术，如“院级盈亏”“成本暂未接入”“未按病种校正的参考值”；`¥0` 与“未接通”不要混用，未接入时不参与毛利率计算或显著标注。

4. `前端代码/src/pages/import-shared/ImportShared.tsx:26`、`前端代码/src/pages/import-console/ImportConsolePage.tsx:17`、`前端代码/src/pages/import-wizard/ImportWizardPage.tsx:12`
   页面：两个导入页。
   违反项：五态、错误恢复。
   为什么是 UX 问题：`useHospitals` 捕获医院列表加载错误，但调用页只取 `hospitals`；实测在正常接口下可看到医院选项，若接口失败，页面会退化成空下拉和“先选择一家合作医院/先选医院和账期”，没有错误、重试或权限解释。
   复现步骤：打开 `/import-console` 或 `/import-wizard`；当前正常截图见 `shots/03-import-console-desktop.png`、`shots/03-import-wizard-desktop.png`；源码显示错误态未被渲染。
   具体修法：`useHospitals` 暴露 `loading/error/reload`；`UploadBar` 显示加载、错误可重试、空医院、无权限四种状态。

## LOW

1. `前端代码/src/pages/import-shared/ImportShared.tsx:10`、`前端代码/src/pages/import-shared/ImportShared.tsx:11`、`前端代码/src/pages/partner-config/PartnerConfigPage.tsx:9`、`前端代码/src/pages/partner-config/PartnerConfigPage.tsx:10`
   页面：4 个 P6 页面共性。
   违反项：项目按钮高度标准。
   为什么是 UX 问题：提示词要求按钮 `h-10`，新 P6 页共用按钮仍是 `h-9`；在导入页、配置页、看板刷新按钮之间视觉密度不一致。
   复现步骤：查看 `/partner-config`、`/import-console`、`/import-wizard` 按钮高度。截图见上述页面截图。
   具体修法：主操作和普通按钮统一为 `h-10`，表格内小按钮单独定义 `btnSm`，不要混用。

2. `前端代码/src/pages/import-shared/ImportShared.tsx:12`、`前端代码/src/pages/hospital-pnl/HospitalPnLDashboard.tsx:15`
   页面：导入体检卡、医院盈利看板。
   违反项：数据诚实。
   为什么是 UX 问题：金额 formatter 用 `Math.round`，实测页面显示整数金额；财务对账差额需要到分，`0.01` 会显示成 `¥0`，削弱对账闭合判断。
   复现步骤：查看导入页和看板金额渲染函数；当前截图中的 KPI 均为整数。截图：`shots/03-hospital-pnl-desktop.png`。
   具体修法：导入、差额、明细统一 `Intl.NumberFormat` 保留 2 位小数；KPI 若要整数，应明确是“约”或单独格式化。

## 实测说明

- 服务确认：`http://localhost:3001/api/health = 200`，`http://localhost:8080 = 200`。
- 登录：`caiwu / CoreOne2026!`；浏览器 UI 登录成功，API 登录也成功。
- 依赖：前端 `npm install` 成功；后端 `npm install` 因 `sqlite3` 原生构建失败，改用 `npm install --ignore-scripts`，源码实际使用 `node:sqlite` / `DatabaseSync`。
- 浏览器控制台：未见页面级 error；仅 React Router v7 future flag warning。
- 未完成项：浏览器插件当前不支持直接设置本地文件到 file input，且上传入口键盘不可达，所以未能通过 UI 真上传 xlsx；409 门禁用后端真实 API 验证。
