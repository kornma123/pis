# 段② 前端 P6 代码审查发现

总体结论：P6 已把 4 个页面和 API 层串起来，但月度向导的 409 门禁契约当前不可用；导入测试台归类闭环、金额显示精度、关键控件 a11y、看板错误态/请求竞态也未达到可上线标准。

## CRITICAL

1. `前端代码/src/api/request.ts:132`、`前端代码/src/api/request.ts:136`、`前端代码/src/pages/import-wizard/ImportWizardPage.tsx:45`、`前端代码/src/pages/import-wizard/ImportWizardPage.tsx:46`
   违反项：409 `NEEDS_CONFIRM` 门禁处理。
   为何是问题：全局 axios 拦截器对非 2xx 返回 `Promise.reject(error)`，也就是原始 AxiosError；后端的 `error.code='NEEDS_CONFIRM'` 在 `error.response.data.error.code` 里。月度向导只匹配 `e.code` / `e.message`，实际只会看到 `ERR_BAD_REQUEST` 或 `Request failed with status code 409`，不会进入 `setNeedConfirm`，确认入库按钮不会出现。
   修法：统一让 request 拦截器 reject 后端结构化错误（保留 status），或在向导 catch 中读取 `e.response?.data?.error`；用 `code === 'NEEDS_CONFIRM' || status === 409` 判定，并把后端 message 放进确认态。补一条 409 mock 单测覆盖按钮出现与二次 `confirm:true`。

## HIGH

1. `前端代码/src/pages/import-console/ImportConsolePage.tsx:46`、`前端代码/src/pages/import-console/ImportConsolePage.tsx:50`、`前端代码/src/api/statement-import.ts:17`、`前端代码/src/pages/import-console/ImportConsolePage.tsx:119`
   违反项：未匹配内联归类闭环不完整。
   为何是问题：测试台只能把 `item` 作为 `keyword` 写回；不能选择 `prefix/remark/newLine/scope`，也没有把 `configVersion` 作为 `expectedVersion` 传给后端。空项目名、按病理号前缀归类、按备注归类、歧义行候选确认、并发配置冲突都会失败或静默写到错误版本，和“写回配置·重预览闭环”不一致。
   修法：AttentionItem 增加规则类型和取值来源（病理号前缀/项目名/备注/新业务线），API body 加 `expectedVersion: preview.configVersion`；409 冲突时要求重新预览；归类成功后更新 lines/version 并重跑 preview。

2. `前端代码/src/pages/import-shared/ImportShared.tsx:12`、`前端代码/src/pages/import-shared/ImportShared.tsx:92`、`前端代码/src/pages/hospital-pnl/HospitalPnLDashboard.tsx:15`
   违反项：金额格式丢失分角精度。
   为何是问题：`yuan()` 用 `Math.round`，会把 `42485.64` 显示成 `¥42,486`，把 `0.01` 对账差额显示成 `¥0`。导入体检卡和财务看板需要精确到分，否则“对账闭合/差额/结算额”展示会误导财务。
   修法：改用 `Intl.NumberFormat('zh-CN', { style:'currency', currency:'CNY', minimumFractionDigits:2, maximumFractionDigits:2 })`；KPI 可另设万元/整数展示，但导入、差额、明细表必须保留 2 位小数。

3. `前端代码/src/pages/import-shared/ImportShared.tsx:50`、`前端代码/src/pages/import-shared/ImportShared.tsx:52`
   违反项：文件上传控件键盘不可达。
   为何是问题：上传入口是 `<label>` 包 `className="hidden"` 的 file input；`display:none` 的 input 不进 Tab 顺序，label 本身也不是键盘可聚焦控件。键盘用户无法触发上传，违反 WCAG 键盘可达要求。
   修法：使用可见 `<button type="button">` 触发隐藏但可访问的 input ref，或用 visually-hidden input + label，并给 label `tabIndex=0`、Enter/Space 处理、`aria-disabled`；busy 时同步禁用可聚焦触发器。

4. `前端代码/src/pages/partner-config/PartnerConfigPage.tsx:250`、`前端代码/src/pages/partner-config/PartnerConfigPage.tsx:258`、`前端代码/src/pages/partner-config/PartnerConfigPage.tsx:335`
   违反项：表单控件没有可编程 label。
   为何是问题：`Field` 只渲染 `<span>`，里面的 input/select 没有 `id/htmlFor` 或 `aria-label`。配置页是大量表单输入，读屏用户无法知道当前字段，浏览器表单辅助能力也失效。
   修法：把 `Field` 改成生成稳定 id 并渲染 `<label htmlFor>`，子控件接收 id；或让 Field 包裹真实 `<label>`。所有 icon-only 删除按钮保留当前 aria-label。

## MEDIUM

1. `前端代码/src/pages/hospital-pnl/HospitalPnLDashboard.tsx:27`、`前端代码/src/pages/hospital-pnl/HospitalPnLDashboard.tsx:38`、`前端代码/src/pages/hospital-pnl/HospitalPnLDashboard.tsx:46`
   违反项：请求状态存在陈旧闭包和竞态。
   为何是问题：`load` 读取 `selected` 却故意从依赖里排除；用户选择医院后点击刷新，会用旧 selected 重新计算 top，可能把选择跳回旧医院。快速切换月份时没有取消/序列号保护，旧请求可覆盖新请求结果。
   修法：把 selected 纳入依赖，或把 `load(targetSelected)` 参数化；为 load 增加 request id / AbortController，只有最后一次请求能落 state；移除 eslint-disable。

2. `前端代码/src/pages/hospital-pnl/HospitalPnLDashboard.tsx:41`、`前端代码/src/pages/hospital-pnl/HospitalPnLDashboard.tsx:86`、`前端代码/src/pages/hospital-pnl/HospitalPnLDashboard.tsx:90`
   违反项：错误态与空态混淆。
   为何是问题：加载失败只 toast，不保存 `error` state；`loading=false` 后 `rows.length===0` 会显示“暂无院级 P&L 数据”。这会把网络/权限/服务错误伪装成真实空数据，违反五态和错误可重试要求。
   修法：增加 `error` state，失败时展示错误面板和重试按钮；成功时清空 error；趋势和负毛利列表也应有局部错误态。

3. `前端代码/src/pages/import-shared/ImportShared.tsx:23`、`前端代码/src/pages/import-shared/ImportShared.tsx:27`、`前端代码/src/pages/import-console/ImportConsolePage.tsx:11`、`前端代码/src/pages/import-wizard/ImportWizardPage.tsx:12`
   违反项：医院列表 hook 的错误态被调用方丢弃。
   为何是问题：`useHospitals` 返回 `err`，但测试台和向导只取 `hospitals`；加载失败时医院下拉为空，没有错误、重试或无权限态，用户会误以为暂无医院。
   修法：hook 返回 `{hospitals, loading, error, reload}`；UploadBar 接收并显示加载/错误/重试/空态；调用页不要吞掉错误。

4. `前端代码/src/pages/hospital-pnl/HospitalPnLDashboard.tsx:136`、`前端代码/src/pages/hospital-pnl/HospitalPnLDashboard.tsx:139`
   违反项：可点击表格行不可键盘操作。
   为何是问题：院级表用 `<tr onClick>` 切换医院，没有 `tabIndex`、键盘事件或按钮语义；键盘用户无法切换趋势图和下钻对象。
   修法：在首列放真实 `<button>` 或给行补 `role="button" tabIndex={0}` 和 Enter/Space 处理；同时提供可见 focus ring。

5. `前端代码/src/pages/partner-config/PartnerConfigPage.tsx:219`、`前端代码/src/pages/partner-config/PartnerConfigPage.tsx:221`
   违反项：Tab 缺少 ARIA 语义与键盘模式。
   为何是问题：6 个配置 Tab 是普通 button 集合，没有 `role="tablist"`、`role="tab"`、`aria-selected`、`aria-controls`，也没有方向键切换；读屏和键盘用户无法获得标准 Tab 体验。
   修法：使用 Radix Tabs（项目已有依赖）或补齐 WAI-ARIA tabs 模式、panel id、方向键 roving tabindex。

6. `前端代码/src/pages/partner-config/PartnerConfigPage.tsx:119`、`前端代码/src/pages/partner-config/PartnerConfigPage.tsx:126`、`前端代码/src/pages/partner-config/PartnerConfigPage.tsx:203`、`前端代码/src/pages/partner-config/PartnerConfigPage.tsx:317`
   违反项：关键流程用原生 `window.confirm`。
   为何是问题：放弃改动、回滚、返回列表、删除业务线都是不可恢复或高风险操作；原生 confirm 无法套用项目样式、焦点管理和详细后果说明，也不利于移动端一致性。
   修法：改 Radix AlertDialog，明确标题、影响范围、主/次按钮、Esc/焦点回收；删除业务线应显示将影响的识别词/收入规则。

## LOW

1. `前端代码/src/pages/partner-config/PartnerConfigPage.tsx:26`、`前端代码/src/pages/partner-config/PartnerConfigPage.tsx:433`
   违反项：复杂度上限。
   为何是问题：单文件约 433 行，超过提示词的 400 行上限；主组件同时管理列表、详情、保存、回滚、基线、6 个 tab，后续状态缺陷会继续增加。
   修法：拆为 `usePartnerConfigPage`、`PartnerListView`、`PartnerConfigHeader`、各 tab 独立文件；保存/回滚/基线动作抽 hook。

2. `前端代码/src/pages/import-shared/ImportShared.tsx:10`、`前端代码/src/pages/import-shared/ImportShared.tsx:11`、`前端代码/src/pages/partner-config/PartnerConfigPage.tsx:9`、`前端代码/src/pages/partner-config/PartnerConfigPage.tsx:10`
   违反项：按钮高度设计令牌不一致。
   为何是问题：项目标准要求按钮 `h-10`，新页面通用按钮是 `h-9`，部分归类按钮追加 `h-8`；同一业务流中按钮高度不一致。
   修法：统一按钮 token 为 `h-10`，小尺寸只用于密集表格内并单独命名 `btnSm`。

3. `前端代码/src/pages/partner-config/PartnerConfigPage.tsx:419`、`前端代码/src/pages/partner-config/PartnerConfigPage.tsx:420`
   违反项：紫色令牌未清。
   为何是问题：提示词要求紫色改主蓝；变更记录回滚状态仍用 `bg-purple-50 text-purple-600`。
   修法：改为 blue/amber 等项目令牌，并确保 hover/focus 状态一致。

4. `前端代码/src/pages/hospital-pnl/HospitalPnLDashboard.tsx:101`、`前端代码/src/pages/hospital-pnl/HospitalPnLDashboard.tsx:108`、`前端代码/src/pages/hospital-pnl/HospitalPnLDashboard.tsx:115`、`前端代码/src/pages/hospital-pnl/HospitalPnLDashboard.tsx:184`
   违反项：plain-Chinese 文案仍有黑话。
   为何是问题：页面出现“上卷”“P&L”“benchmark”“case”等内部/英文术语，不符合提示词 plain-Chinese 要求。
   修法：替换为“按医院汇总”“医院盈亏”“基准未做病种校正”“病例”等面向财务用户的中文。
