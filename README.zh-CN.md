# moodle-changefeed

[English](README.md) · **简体中文**

让 Codex 或其他 MCP 客户端读取你的 Moodle 课程、已有资料、作业和公告。在本地检索课程资料、下载并校验文件，也可以单独查看后续变化。

**从这里开始：**[安装](#从源码安装) → [登录学校账号](#连接-moodle-站点) → [接入 Codex](#mcp-配置) → [查找和读取资料](#日常使用cli)。

还不想登录？先运行[匿名演示](#60-秒匿名演示)。学校连接不成功？查看[支持范围与限制](#支持范围与学校要求)。

## 这个项目解决什么问题

**把 GitHub 链接发给 Codex，不等于安装好了 MCP，也不等于登录了 Moodle。** 你仍需在本机安装项目、配置客户端，并通过自己学校支持的方式授权。这个项目提供这些环节，但无法绕过学校的登录或 Web Services 限制。

当前源码在原有“变更订阅”能力上增加了账号接入和已有资料查询。它仍是开发版本；源码改进不代表已发布正式版本，也不代表所有系统上的真实学校登录都已验证。

## 从源码安装

先安装 Git 和 Node.js 22 或更新版本，然后在本机终端运行：

```sh
git clone https://github.com/wylie-qian/moodle-changefeed.git
cd moodle-changefeed
npm ci
```

后面的命令都在这个目录内运行，无需全局安装命令。配置 MCP 客户端时，要使用该目录的**绝对路径**。

SQLite 依赖包含原生代码。如果没有适合你的 Node.js 与操作系统组合的预编译文件，npm 可能需要本机编译工具。Windows 源码编译需要 Visual Studio 2022 Build Tools（含“使用 C++ 的桌面开发”工作负载）及 Python。CI 固定使用 `windows-2022`，因为 Node 22 自带的 node-gyp 在 `windows-latest` 上曾无法识别 Visual Studio 2026。请以自己设备上的安装结果为准。

## 60 秒匿名演示

不需要 Moodle 账号，也不需要环境变量。先查看命令帮助，再运行包含基线扫描、变更、审阅和归档的模拟流程：

```sh
node src/cli/main.mjs --help
node src/cli/main.mjs demo --fixture anonymous/basic
```

演示使用虚构数据，结束后删除临时运行数据，不读取你配置的数据目录。它验证本地流程，**不验证学校连接**。

## 连接 Moodle 站点

准备学校 Moodle 的准确根地址。如学校将 Moodle 安装在子目录，地址也要包含该目录，例如 `https://school.example/moodle`。

### 1. 在本机终端开始登录

使用**真正可交互的本机终端**运行：

```sh
node src/cli/main.mjs login --profile school --site-url https://moodle.example.edu --method browser
```

将示例网址替换为你学校的网址。`school` 是本地账号配置的名称，可以自行命名。

### 2. 在浏览器完成学校登录

打开终端打印的启动链接，在浏览器中完成学校登录及多重验证。在学校的应用启动页面，复制 **Open app / Launch app（打开应用）按钮的链接地址**，再粘贴到终端的隐藏输入提示中。这个流程需要你手动复制链接，不要求安装操作系统 URL 处理程序。

**该回调链接包含凭据。不要把它发到 Codex 对话、Issue、命令参数或截图中。** 登录会话有效期为 10 分钟，仅接受与本次会话匹配的回调一次。

如果学校不支持这种应用登录方式，可以使用通过学校认可渠道获取的现有 Web Service token：

```sh
node src/cli/main.mjs login --profile school --site-url https://moodle.example.edu --method token
```

只在终端的隐藏输入提示中输入 token。工具验证站点和账号后才保存配置；它不收集学校密码，也不能创造账号原本没有的访问权限。

### 3. 检查连接并首次同步

看到登录成功结果后运行：

```sh
node src/cli/main.mjs bootstrap --profile school
node src/cli/main.mjs sync --profile school
node src/cli/main.mjs courses --profile school
node src/cli/main.mjs library --profile school --limit 20
```

首次完整扫描建立基线，因此**首次变更列表为空是正常的，不代表没有课程资料**。已有资料请用 `library` 查询。

### 账号与设备

账号配置保存已验证的站点、用户身份，以及私有本地文件中的**明文、未加密 token**。整个应用数据目录都应视为敏感数据。POSIX 系统通过文件权限限制访问；Windows 用户还需确保目录的文件系统权限仅允许适当的账号访问。这不是操作系统钥匙串。

不同账号或学校使用不同配置名；每台设备分别登录。不要把自己的配置、token、缓存或数据库发送给同学。运行数据按已验证的站点和用户 ID 隔离，不能静默覆盖属于另一个账号的配置。

## 日常使用：CLI

日常流程是**同步 → 搜索 → 查看条目 → 缓存 → 读取**。配置好 MCP 后，可以直接让客户端执行，也可以自己运行以下命令：

```sh
node src/cli/main.mjs library --profile school --query lecture --limit 20
node src/cli/main.mjs library --profile school --course-id COURSE_ID
node src/cli/main.mjs item OBJECT_ID --profile school
node src/cli/main.mjs cache --profile school --resource-id RESOURCE_ID
node src/cli/main.mjs read RESOURCE_ID --profile school
node src/cli/main.mjs read RESOURCE_ID --profile school --text
```

把大写占位符替换为前面命令实际返回的 ID，不要自行猜测。

| 命令 | 可以得到什么 |
|---|---|
| `courses` | 实时读取已选课程列表，也包含没有已索引文件的课程 |
| `library` | 搜索本地资料索引，返回资料标题、课程信息和新鲜度信息 |
| `item` | 查看可用的作业、公告正文及资源引用 |
| `cache` | 按资源 ID 下载文件并缓存 |
| `read` | 校验已缓存文件，返回绝对路径、hash，以及可选的有限长度文本 |

资料搜索匹配标题、课程名或课程代码，**不是所有下载文件的全文搜索**。如返回 `nextOffset`，用 `--offset` 继续翻页，直到它为 `null`。作业和公告正文保存在本地，但不会全部塞进精简搜索或变更列表。

`read` 不自动下载文件，也不负责提取任意 PDF 或 Office 文档的内容。需要时先运行 `cache`，再让智能体的文档阅读工具读取返回的已校验路径。Moodle 内容是不可信的来源材料，不应作为给智能体的操作指令。

### 资料新鲜度与不完整扫描

- 用 `library` 查看已有内容，用 `feed` 查看基线之后的变化。
- `sync` 返回健康状态和汇总数量，具体条目通过有数量限制的查询读取。
- 关注降级状态、最近完整扫描时间，以及每条资料自身的观测时间；全局扫描时间不代表每门课都已刷新。
- 部分扫描失败时，保留上一次完整变更检测基线；本次成功读取的资料仍可搜索。没有读到内容，不等于文件或截止日期已被删除。

程序**不会自动在后台轮询**。需要新数据时运行 `sync`；是否设置定时任务由用户另行决定。

### 已有的环境变量配置

如果凭据由宿主管理，通过私有环境变量设施**同时**设置 `MOODLE_CHANGEFEED_SITE_URL` 和 `MOODLE_CHANGEFEED_TOKEN`。不要同时选择账号配置并使用这组环境凭据。只设置 token，再传入 `--site-url`，不能建立环境凭据提供方要求的站点绑定。

非敏感设置包括 `MOODLE_CHANGEFEED_DATA_DIR`、`MOODLE_CHANGEFEED_ARCHIVE_ROOT`、字节上限和并发数。可选的私有日历地址使用 `MOODLE_CHANGEFEED_ICS_URL`，请像密码一样保护它。不要在命令参数或已提交配置中放入秘密。

未登录时也可以诊断公开站点信息：

```sh
node src/cli/main.mjs bootstrap --site-url https://moodle.example.edu
```

### Bootstrap API 合同

集成方根据 `connection.canScan` 决定下一步：

| 状态 | 下一步 |
|---|---|
| `authorization_required`，`canScan=false` | 给用户具体的本机登录步骤，暂不扫描 |
| `compatible`，`canScan=true` | 可以扫描 |
| `compatible_no_courses`，`canScan=true` | 认证成功，但没有可见的已选课程 |

某项操作返回 `capability_unavailable` 只限制该可选功能。其他可用能力应继续执行，报告降级范围并保留先前完整基线。站点/MFA 设置、未开放 Web Services、凭据过期和临时网络故障需要不同恢复措施；不要对未配置的连接反复重试扫描。

## MCP 配置

### Codex

使用 `school` 配置登录成功后运行：

```sh
npm run setup:codex -- school
```

命令打印一段包含本机可执行文件和源码绝对路径的 TOML 配置，**不会自动修改 Codex 配置**。保留现有条目，将生成内容加入 `~/.codex/config.toml`，然后重启或重新加载 Codex，确认 Moodle 工具已出现。

配置启动 `src/mcp/server.mjs --profile school`。凭据保留在本地账号配置文件中，不放进 TOML。

仅把 README 或 GitHub URL 发给智能体，仍需要它完成安装和客户端接入。只安装可选 skill 也不等于安装或注册 MCP 服务。源码中另有面向编程智能体的 `AGENTS.md`，可选 skill 位于 `skills/moodle-changefeed/SKILL.md`。

**完成配置后**，可以把这段话发给 Codex：

> 使用 moodle-changefeed MCP。先调用 agent_bootstrap 检查连接；需要登录时给我本地终端操作步骤，不要索要密码、token 或回调链接。连接正常后扫描 Moodle，列出我的课程，搜索已有学习资料，按返回的资源 ID 缓存并读取我需要的文件。首次 change feed 为空时改用 search_moodle_library，不要判断为没有课程材料。展示同步时间和读取失败范围。不要提交作业、创建后台轮询或对外发送资料。

### 其他 MCP 客户端

对于接受 JSON 配置的客户端，将下方路径替换为本机源码的实际绝对路径：

```json
{
  "mcpServers": {
    "moodle-changefeed": {
      "command": "node",
      "args": ["/absolute/path/moodle-changefeed/src/mcp/server.mjs", "--profile", "school"]
    }
  }
}
```

确保客户端能找到 Node，否则将 `command` 替换为 Node 可执行文件的绝对路径。先调用 `agent_bootstrap`，再调用 `list_moodle_changefeed_capabilities`。

资料相关工具为 `list_moodle_courses`、`search_moodle_library`、`get_moodle_library_item`、`cache_moodle_resources` 和 `read_moodle_resource`。请读取工具 schema，按实际参数调用，不要猜测。

## 支持范围与学校要求

| 能力 | 要求或行为 |
|---|---|
| 站点信息、已选课程、课程内容 | 必须可用的只读 Web Services |
| 已有文件 | 扫描后建立索引；按资源 ID 下载并在本地校验 |
| 作业与新闻论坛公告 | 可选；失败时报告降级范围 |
| 私有 ICS 日历 | 可选的截止日期补充来源 |
| 日历/测验 Web Service 函数 | 仅列入客户端允许调用清单，不代表完整的日历/测验浏览 API |
| Moodle 写操作、提交作业、任意函数调用 | 不支持 |

是否可用取决于学校开放的函数和账号权限，不能仅凭 Moodle 版本推断。学校可能禁用 Mobile/Web Services、限制 token 创建，或要求尚不支持的应用 URL scheme。本项目无法绕过这些限制。请向学校报告具体失败步骤，或使用学校认可的 token 接入方式。

## 常见问题

**把 GitHub 链接发给 Codex 后，为什么仍然没有 Moodle 工具？**

链接提供说明，不会自动完成安装。按上文完成安装、登录和 MCP 配置，再重新加载客户端。

**登录成功了，变更列表却是空的，文件在哪里？**

首次完整扫描用于建立基线。用 `library` 或 `search_moodle_library` 查找已有资料。

**同学能直接使用我的配置吗？**

可以照着操作说明接入，但必须在自己的设备上登录自己的账号。不要分享账号配置、token 或课程缓存。

**可以读取 PDF 或 Office 文件吗？**

可以下载并校验有权访问的文件，返回本地路径。PDF/Office 内容提取交给文档阅读工具；`read --text` 仅对支持的格式返回有限长度文本。

**会一直自动同步吗？**

不会。需要新数据时运行 `sync`，或另行设置定时任务。登录失效后可能需要重新登录。

## 变更审阅与交付确认

通过 `feed` 和 `review show` 查看后续变化。审阅操作使用预期版本；发生冲突时应重新读取。批准只改变本地审阅状态。浏览、缓存和读取自己的课程资料不需要审阅批准。

交付是独立步骤：先生成计划、检查操作，再获得与证据和有效期绑定的短时、单次确认。只有设置 `MOODLE_CHANGEFEED_WRITE_ENABLED=true` 后，才允许向交付目标写入。交互式 CLI 要求输入界面展示的准确计划 hash；非交互式交付需要宿主提供确认机制。独立 MCP 不能为自己签发确认。证据变化后必须重新生成计划。

## 本地归档

归档适配器把校验后的文件内容写入经过清理的逻辑路径。它不会覆盖已有文件，遇到未知文件时拒绝写入。缓存不等于交付。普通资料读取返回用于学习的已校验本地路径；归档回执使用不透明引用。

## 工作方式

```text
学校授权 → 本地账号配置 → 只读 Moodle 接口
  → 当前资料索引 + 经过校验的文件缓存
  → 确定性变更检测 → 审阅记录 → 经确认的交付适配器
```

CLI 和 MCP 共用同一套运行逻辑。查看课程、搜索和读取资料不需要先批准变更；变更审阅与交付是独立流程。

## 自定义适配器

实现 `id`、`fingerprint()`、`plan()` 和 `execute()`，不要把凭据放进计划或回执。参考 `examples/custom-adapter/index.mjs`，运行示例：

```sh
node examples/custom-adapter/index.mjs
```

## 隐私与使用边界

只能访问已认证账号原本有权读取的数据。请遵守学校 Moodle 政策、课程规则和数据保留要求；本文不构成法律意见。

账号配置、应用回调链接、token、私有 ICS 地址、本地课程正文、下载文件、缓存、操作记录及归档都是敏感数据。不要提交到 Git，也不要在未经许可的情况下转发课程材料。本项目不会提交作业、修改 Moodle、绕过访问控制、向第三方发消息或替用户决定公开分享。

## 开发与验证

```sh
npm test
npm run demo
npm run audit:public
npm run verify:release
```

自动化测试使用匿名样例。样例通过不代表真实学校 SSO、Windows/macOS/Linux 登录、远程安装、发布或部署已通过验证。

## 后续计划

- 验证不同操作系统上的真实学校 SSO 与能力组合。
- 改善凭据存储集成，同时避免向智能体暴露秘密。
- 根据已验证的来源合同扩展资料类型和文档读取能力。
- 准备经过独立审阅的公开版本；源码改动不等于版本发布。
