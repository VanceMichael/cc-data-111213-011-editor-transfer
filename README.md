# 富文本门户的语义化录入与回读

editor-transfer 用于合作资料的本地查看和来源保存，并支持把结构化安装说明录入合作门户的富文本草稿。资料对象按内容摘要保存，每次领取保留单独回执；录入只使用门户的可见工具栏，成功与否按业务语义回读判断。

## 运行环境

使用 Node.js 22。依赖已锁定；首次准备执行 `npm ci --ignore-scripts`，正式运行无需下载资料或软件。全部样例使用合成数据与本机来源，不连接生产系统。

```bash
npm run check
npm test
npm run demo
```

`npm run demo` 在临时目录实际读取资料、归档并重新核验摘要，退出时清理临时内容。随后启动本地门户和 Chromium，用可见工具栏录入合成安装说明，并把完整录入、语义重试、中途重读、保存延迟、冲突和人工交接六个场景写到 `.local/demo/report.html` 与 `report.json`。浏览器在环境准备阶段安装，正式运行不下载。演示只保存草稿，不执行最终发布。

## 本地来源门户

`fixtures/portal/` 是合成业务来源的页面与交互脚本，由 `src/portal.js` 提供本地 HTTP 服务；浏览器功能测试直接操作这些页面。

运行 `npm start -- --port 4173` 后访问终端显示的本地地址，按 Ctrl+C 停止；端口也可由 `PORT` 配置。

## 资料操作

```bash
npm run cli -- inspect fixtures/portal.json
npm run cli -- capture fixtures/portal.json .local/archive
npm run cli -- list .local/archive
```

`capture` 只表示来源字节已保存，不声称领域流程已自动完成。已有查看功能只展示现有资料，不替代业务接纳判断。`scripts/create-fixtures.js` 用于维护者重建合成资料；运行与测试直接读取已提交的资料。

## 结构化录入

```bash
npm run cli -- transfer                    # 空白草稿 + 内置合成资料
npm run cli -- transfer --source source.json   # 指定来源 JSON
npm run cli -- transfer --blank-draft          # 仅本地合成门户：先重置为空白草稿
```

录入器只使用门户页面上可见的按钮（强调、有序步骤、要点、链接）和键盘操作：输入文字、移动与扩展选区、回车分段、撤销/重做。它不写编辑器内部模型，不调用 `/api/document` 保存内容，也不修改门户后台存储；演示和测试里的 `/api/control` 只用于准备空白草稿或模拟他人修改。

来源格式是块数组：

```json
{"blocks": [
  {"type": "paragraph", "runs": [{"text": "开始前阅读 "}, {"text": "安全须知", "bold": true}, {"text": " 与 "}, {"text": "接线图", "link": "https://example.test/wiring"}]},
  {"type": "orderedList", "items": [{"runs": [{"text": "拆包核对铭牌。"}]}]},
  {"type": "warning", "runs": [{"text": "警告：", "bold": true}, {"text": "未接地严禁上电。"}]}
]}
```

想表达的业务语义只有：段落、一层有序/要点列表、行内强调、链接目标、警告块。录入结果从编辑器 DOM 回读成同一套模型再比较，忽略空白和 `p`/`div` 包装等排版归一化，但不忽略步骤顺序、列表类型、强调和链接目标。不使用 HTML 字符串相等判断成功。

几处不可见约束会改变录入策略：

- **嵌套列表没有可见入口**：门户工具栏没有缩进按钮，Tab 只会移走焦点；原生拖拽和切贴也不会产生嵌套列表。因此嵌套列表及其之后的块一律停止录入并交人工，不拍平、不删除，也不调整顺序越过它。
- **警告块**是“警告：”加粗开头的段落。门户在列表末尾按回车会生成 `div` 段落，回读时按段落处理。
- **输入法合成**：每次输入后等待语义稳定；选区长度与预期不符时，把当前块视为可重试失败。
- **选区丢失与撤销栈**：每个块是一个可重试边界。回读不符时按语义断点在撤销栈上回退（按语义判断该撤销还是重做），再用同一交互路径重录。
- **保存延迟**：录入完成不等于已保存；草稿修订号以门户的保存回执和重新读取结果为准。
- **冲突**：自动保存与人工修改相遇时先停下，重新读取对方版本并列出对方新增的警告，不覆盖；请人工合并后再继续。

报告把三件事分开：`editBoundary`（本次可重试的编辑边界与重试次数）、`draftRevision`（草稿修订号）和 `published`/`finalPublish`（最终发布，本工具始终不做）。

## 目录约定

- `src/domain.js`：现有领域读取和查看接口。
- `src/archive.js`：内容对象、来源回执与完整性检查。
- `src/semantic.js`：业务语义模型、来源规范化、差异比较和录入计划。
- `src/transfer.js`：通过可见交互录入并做语义回读、重试与冲突处理。
- `src/demo.js`：本地演示与 HTML 报告。
- `fixtures/`：本地资料与领域配置。
- `test/`：已有行为的运行验证，使用独立临时目录。

## Linux 环境

`Dockerfile` 使用 Node.js 22 镜像；浏览器项目使用包含 Chromium 的运行镜像。可执行 `docker build -t editor-transfer:local .` 后运行 `docker run --rm --network none editor-transfer:local npm test`。测试中的 HTTP 和门户都仅绑定回环地址；不需要第二个容器。构建阶段准备依赖，运行时不安装依赖。
