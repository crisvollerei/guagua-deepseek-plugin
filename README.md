# DeepSeek 聊天插件（trss-yunzai）

QQ 群聊天插件：以 `#呱瓜` 开始对话，支持自然分段、限时接话、引用续聊、图片与 GIF 理解、网页搜索和人物记忆。

明确开始话题后，参与者可以短时间内自然补充，不必每句都加触发词。其他成员可以引用机器人已发出的回答加入。平时的昵称提及和无关群聊不启动模型，其他插件的命令原样放行；等待时不发送固定问候或“我在听哦”。

## 安装

需要 trss-yunzai / Yunzai-Bot 框架环境、Redis、Node.js 20 或更高版本，以及可用的 DeepSeek 兼容接口。GIF 抽帧另外需要 FFmpeg，缺失时回退原图。

1. 将仓库放入框架插件目录：

   ```bash
   git clone https://github.com/crisvollerei/guagua-deepseek-plugin.git plugins/guagua-deepseek-plugin
   cd plugins/guagua-deepseek-plugin
   npm install
   ```

2. 在 `config.js` 填写 `deepseek.apiKey`，或为机器人进程设置 `DEEPSEEK_API_KEY`。接口地址可用 `DEEPSEEK_BASE_URL` 覆盖。
3. 按需把 `member-profile.example.json` 复制为 `member-profile.json`，填写人物资料和 `role: "master"` 的主人；框架的 master 权限仍负责管理命令授权。
4. 重启机器人，发送 `#呱瓜 你好`。修改 `config.js` 后同样需要重启。

默认使用 DeepSeek 官方搜索和抓取，复用对话密钥。选择 Ollama 兼容服务时，另填写 `webSearch.apiKey` 或设置 `OLLAMA_API_KEY`。模型名由 `deepseek.defaultModel` 和 `deepseek.models` 指定，实际可用模型及能力以所用端点为准。

## 配置入口

| 配置 | 用途 |
| --- | --- |
| `deepseek.*` | 接口地址、密钥、模型映射、超时、重试、思考与采样参数 |
| `webSearch.*` | 搜索服务、工具开关、Ollama 搜索与抓取地址 |
| `command.*` | 聊天、重置、管理、人工资料和独立记忆命令前缀 |
| `chat.*` | 上下文、温度、思考过程显示、图片数量和体积预算 |
| `quoted.*` | 引用续聊开关、有效期和窗口数量 |
| `listening.*` | 明确入口后的限时接话开关、参与期限、判断温度和输出预算 |
| `gif.*` | 动图处理开关、FFmpeg 路径、拼图单格大小和解码超时 |
| `profile.*` | 人工资料路径、缓存秒数、称呼长度上限 |
| `memory.defaults` | 首次生成 `memory-config.json` 时采用的初始值 |
| `persona.*` | 机器人昵称、主人、优先识别名单、分群设定和人设模板 |

聊天设置优先使用 Redis 中已有的值，`config.js` 提供默认值。`#ds设置提示词` 保存的人设也继续优先于模板；旧人设模板或自定义提示词中若有强制学习元数据、固定问候或每轮追问，应在对应配置或同一命令中调整。

`chat.historyLength` 默认 `0`：直接聊天不额外读取近期群消息。手动调高会把指定数量的近期群历史加入直接对话；限时接话和引用续聊仍只使用本话题选中的内容。已有 Redis 值不会被默认值覆盖。`chat.maxLength` 控制本话题问答历史，设为 `0` 时不附带已处理历史，当前消息和当前引用仍可使用。

图片默认每轮最多 4 张、每张 8 MiB、请求总体预算 44 MiB，这三个上限可下调。普通图片保持原处理；GIF 默认取 6 帧组成 2×3 拼图，使用缓存并在解码失败时回退。

## 常用命令

示例使用默认前缀，自定义后以 `config.command` 为准。

| 命令 | 行为 | 权限 |
| --- | --- | --- |
| `#呱瓜 内容` | 聊天、识图、搜索、按需查询资料 | 所有人 |
| `#结束对话` | 清理当前对话、摘要和短时话题；保留长期记忆 | 所有人 |
| `#呱瓜资料查看/添加/删除/重载` | 管理人工人物资料 | master |
| `#memory` / `#memory 待确认 [昵称或QQ号]` | 查看待确认记忆 | master |
| `#memory 查看 [昵称、QQ号或M编号]` | 查看记忆或单条记录 | master |
| `#memory 确认 1-3` / `#memory 1-3 是 昵称` | 按已展示的列表批量确认、绑定人物 | master |
| `#memory 确认全部` / `#memory 确认成员 昵称` | 批量处理明确归属的记录 | master |
| `#memory 忽略 1,3-5` / `#memory 忽略成员 昵称` | 忽略不需要的记录 | master |
| `#memory 修正 M1 内容` / `#memory 删除 M1` | 修正或删除固定编号的记忆 | master |
| `#memory 提醒` / `#memory 提醒间隔 6` | 私聊展示待确认项、调整提醒间隔 | master |
| `#memory 提醒模式 变化` / `全部` | 仅提醒新增变化，或定期展示完整列表 | master |
| `#memory 本次 [昵称或QQ号]` | 查看最近已发送回复得到的自动记忆参考 | master |
| `#ds帮助` | 查看设置和命令 | master |
| `#ds切换模型 flash` / `pro` | 按配置的映射切换模型 | master |
| `#ds切换模式 友好` / `毒舌` / `严肃` | 切换互动模式 | master |
| `#ds思考模式 开启` / `关闭` | 开关思考模式 | master |
| `#ds设置温度 0.8` | 调整温度 | master |
| `#ds设置上下文长度 3` | 调整本话题上下文轮数 | master |
| `#ds设置群聊记录长度 0` | 调整额外近期群历史条数 | master |
| `#ds设置提示词 内容` | 保存自定义人设 | master |
| `#ds设置思考过程 关闭` / `开启` / `转发` | 设置思考过程显示方式 | master |
| `#ds搜索服务` / `deepseek` / `ollama` | 查看或切换搜索与抓取服务 | master |

`#memory` 与操作之间必须留空格或换行，引用提醒后也要带前缀。稳定个人资料跟随 userid，仅在本人当前所在群可用；临时状态、约定、称呼和关系留在原会话。待确认资料只作参考，近期事件与约定免确认但有期限。明确取消、完成和改期会更新对应事项，记录约定不会自动设置到点提醒。

群规、群服务器地址等明确属于群本身的知识有独立群主体，作者离群后仍可在本群使用。机器人呼叫、普通玩笑和归属不明的称呼不会自动当成人物事实。

## 限时接话与引用

成功回答后，默认保留 60 秒的参与者接话期限和 90 秒的有效引用窗口，均可配置。其他群友通过有效引用加入，各条发言按真实 userid 区分。新消息按固定的 8、4、2 秒阶段合并，再用轻量判断决定回复、等待、静默或结束；同一次判断可选出值得记忆的消息，静默不等于不能记住明确事实。

分段只负责自然停顿，沿用原人设和语气，不固定追问。长篇内容可先给结论，再用合并转发展示。用户明确要求单条时完整直发。只有实际发送成功的正文进入历史和引用窗口。

## GIF 与容器

将 FFmpeg 安装在机器人运行环境，或设置 `gif.ffmpegPath` / `GUAGUA_FFMPEG_PATH` 指向可执行文件。在容器中可把宿主机存放 FFmpeg 的目录挂载到容器固定路径，再配置该容器路径；更新机器人镜像时可继续使用挂载的工具。文件需要可执行，并与容器系统及 CPU 架构兼容。

缓存位于资料目录下的 `cache/gif`，可自动重建，无需随部署复制。缺少 FFmpeg、解码超时或损坏动图会回退原图，并告知模型只拿到了静态画面。

## 文件与升级

```text
index.js                    # 框架入口
config.js                   # 配置和泛化人设模板
guagua-memory.mjs           # 记忆、摘要与审核
guagua-roster.mjs           # 群资格与成员变化
guagua-web.mjs              # 搜索与抓取
guagua-reply.mjs            # 自然分段和引用窗口
guagua-listen.mjs           # 限时接话判断
guagua-vision.mjs           # GIF拼图和缓存
guagua-model.mjs            # 模型输出契约
member-profile.example.json # 人工资料模板
tests/                      # 离线测试
```

程序文件与 `config.js` 放在同一插件目录。升级时替换程序，保留自己的密钥、人物与群设定、人工资料、记忆、成员表及 Redis 设置，不要用模板覆盖运行数据。参考新 `config.js` 合并新增配置区段和人设交互规则；旧配置中缺失的新字段使用内置默认值。`profile.file` 可改变资料位置，记忆运行文件和 GIF 缓存跟随资料目录。

`memory-config.json` 首次按 `config.memory.defaults` 生成；文件已存在时以其中内容为准，运行中约每 15 秒读取。`member-profile.json`、`memory.json`、`memory-config.json`、`group-members.json`、缓存和临时文件均不属于仓库内容。

详细说明：[记忆功能](记忆功能使用说明.md)、[聊天回复与识图](聊天回复使用说明.md)、[联网功能](联网功能使用说明.md)。
