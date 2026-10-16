# DeepSeek 聊天插件（trss-yunzai）

基于 trss-yunzai / Yunzai-Bot 系的 QQ 机器人聊天插件：`#呱瓜` 对话 + `#陪伴` 陪伴聊天模式。

---

## 文件结构

```
guagua-deepseek-plugin/
├── index.js                    # 插件主文件（命令处理 / 聊天 / 陪伴模式 / 资料与记忆管理）
├── config.js                   # 配置文件（密钥、模型、命令前缀、人设、陪伴与记忆参数）
├── guagua-memory.mjs           # 长期记忆模块（后台提取 / 确认 / 召回 / 摘要，独立可测）
├── member-profile.example.json # 用户资料库模板（复制为 member-profile.json 后填写）
├── package.json                # 依赖声明（openai、axios）
├── LICENSE
└── README.md                   # 本说明文档
```

运行时生成（均已在 `.gitignore` 中忽略）：

```
member-profile.json   # 人工资料库（你填写）
memory.json           # 长期记忆 + 对话历史（自动维护，勿手改）
memory-config.json    # 记忆运行参数（首次启动按 config.memory.defaults 生成）
```

## 安装

1. 下载插件（任选其一）：
   - Git：`git clone https://github.com/crisvollerei/guagua-deepseek-plugin.git`
   - 或直接下载 ZIP 压缩包并解压

2. 将 `guagua-deepseek-plugin` 整个文件夹放入 trss-yunzai 的插件目录：

   ```
   plugins/guagua-deepseek-plugin/
   ```

3. 安装依赖（在项目根目录或插件目录执行）：

   ```bash
   npm install openai axios
   ```

4. 按下文「配置流程」填写 API Key。

5. 重启机器人，插件自动加载。

## 配置（config.js）

| 配置项 | 说明 |
|---|---|
| `deepseek.baseURL` / `deepseek.apiKey` | DeepSeek 接口地址与密钥（**必须替换**） |
| `deepseek.defaultModel` / `models` | 默认模型与 `#ds切换模型` 的模型映射（默认 `deepseek-flash` / `deepseek-v4-pro`，使用第三方网关时请改为网关支持的模型名） |
| `webSearch.apiKey` / `apiUrl` / `enabled` | 联网搜索（Ollama Web Search Cloud API）密钥、地址与开关（**密钥必须替换**） |
| `command.chatPrefix` / `reset` / `companion` / `adminPrefix` | 各命令触发前缀（需以 `#` 开头） |
| `chat.*` | 对话默认参数（上下文长度 / 群聊记录长度 / 温度 / 思考过程显示 / 多模态图片上限与超时 / 单条消息截断长度），运行时被 redis 中已保存的配置覆盖 |
| `profile.*` | 用户资料库：文件名、内存缓存时长、学习称呼长度上限 |
| `memory.*` | 长期记忆：是否用 `defaults` 生成 `memory-config.json`，以及提取批次、各类保留天数、召回条数、提醒周期等初始默认值 |
| `companion.*` | 陪伴模式参数（判断/回复冷却、缓冲上限、摘要参数、自动关闭时长等） |
| `persona.*` | 人设：机器人昵称、主人信息、优先识别名单（`preferredUsers`）、群特殊设定（`groupSettings`）、默认人设模板（`systemPrompt`，支持 `{{botName}}` 等占位符） |

## 配置流程（详细版）

按以下步骤即可完成插件的完整配置：

### 第 1 步：获取 DeepSeek API Key（必需）

1. 打开 DeepSeek 开放平台：<https://platform.deepseek.com>
2. 注册 / 登录后，进入 **API Keys** 页面
3. 点击「创建 API Key」，复制生成的 `sk-` 开头的密钥（**只显示一次，请立即保存**）
4. 官方模型名对照：
   - `deepseek-flash`：通用对话模型（V4.1 Flash，原生多模态视觉，默认使用）
   - `deepseek-v4-pro`：深度思考模型（`#ds切换模型 pro` 切换）
   - 历史命名 `deepseek-chat` / `deepseek-reasoner` 官方仍保持兼容

### 第 2 步：获取 Ollama Web Search Key（可选，用于联网搜索）

1. 打开 Ollama：<https://ollama.com>，登录后进入 Cloud / API 设置
2. 生成 API Key（形如 `uuid.token`）
3. 如果不需要联网搜索功能，可将 `config.webSearch.enabled` 改为 `false`，跳过本步

### 第 3 步：填入配置（直接编辑 `config.js`）

打开 `config.js`，将密钥直接填入对应字段：

```js
deepseek: {
  apiKey: 'sk-你的DeepSeek密钥',      // 必填
},
webSearch: {
  apiKey: '你的Ollama密钥',           // 启用联网搜索时必填
  enabled: true,
},
persona: {
  botName: '呱瓜',                    // 机器人昵称（可改）
  master: { name: '主人', qq: '' },   // 主人信息
  // preferredUsers / groupSettings 按需补充
}
```

保存后即生效，无需其他操作。

### 第 4 步：安装依赖并重启

```bash
npm install openai axios   # 在 trss-yunzai 项目根目录执行
# 重启机器人，插件自动加载
```

### 第 4.5 步：配置用户资料库（可选但推荐）

插件会把「群友的昵称 / 生日 / 称呼 / 分群设定」等资料从系统提示词中剥离出来，存到插件同级的 `member-profile.json`，在对话涉及某位 userid 时动态注入。这样既不占用常驻提示词，AI 也能通过工具按需查询。

1. 把模板复制为实际文件：

   ```bash
   cp member-profile.example.json member-profile.json
   ```

2. 按 userid 填写用户资料：

   ```json
   {
     "version": 1,
     "users": {
       "10001": {
         "name": "示例群友",
         "role": "master",
         "gender": "女",
         "birthday": "8月25日",
         "aliases": ["小示"],
         "special": "注意事项（会注入 AI，例如语气要求）",
         "groups": {
           "123456789": {},
           "987654321": { "note": "该用户在此群的特殊设定" }
         },
         "learned": []
       }
     },
     "pending": []
   }
   ```

3. 字段说明：

   | 字段 | 说明 |
   |---|---|
   | `name` | 昵称（AI 优先使用的称呼） |
   | `role` | `master` 表示主人（可使用 `full_export` 全量导出资料） |
   | `gender` / `birthday` | 性别 / 生日（生日格式 `X月X日`，用于生日查询工具） |
   | `aliases` | 别称列表 |
   | `special` | 注意事项，注入给 AI |
   | `groups` | 按群设定，`note` 仅在该群生效 |
   | `learned` | AI 学习到的称呼（由插件自动写入，一般不用手改） |
   | `pending` | AI 拿不准的新名字（待主人确认） |

4. 不想手改文件时，也可用命令管理（仅 master）：

   ```
   #呱瓜资料查看 <昵称/userid>
   #呱瓜资料添加 <昵称> <userid> [备注]
   #呱瓜资料删除 <昵称/userid>
   #呱瓜资料重载
   #呱瓜记忆查看
   #呱瓜记忆删除 <userid> <别名>
   ```

> `member-profile.json` 已在 `.gitignore` 中忽略（含真实 QQ 号等隐私，请勿提交）。

### 第 5 步：验证

- 群内发送 `#呱瓜 你好`，应收到 AI 回复
- 发送 `#ds帮助`（仅 master 可见）查看当前配置与全部命令
- 发送 `#陪伴` 开启陪伴模式体验主动对话

### 安全提醒

- `config.js` 中的 `your_deepseek_api_key_here` / `your_ollama_api_key_here` 仅为占位符，请务必替换为你的真实密钥
- 本仓库为公开仓库，**请勿把真实密钥提交到仓库**：本地使用可填写真实密钥，推送 / 分享前请将密钥恢复为占位符
- 若怀疑密钥泄露，请立即到对应平台吊销并重新生成

## 命令

| 命令 | 说明 | 权限 |
|---|---|---|
| `#呱瓜 <内容>` | 与呱瓜聊天（支持图片理解 / 引用消息 / 联网搜索 / 资料查询） | 所有人 |
| `#结束对话` | 重置当前对话上下文 | 所有人 |
| `#陪伴` / `#陪伴关闭` / `#陪伴状态` | 陪伴模式开关与状态（支持 `#呱瓜陪伴` 系列） | 所有人 |
| `#呱瓜资料查看/添加/删除/重载` | 用户资料库管理（人工录入） | master |
| `#呱瓜记忆查看 [昵称/userid]` | 查看长期记忆与近期事件 | master |
| `#呱瓜记忆待确认` | 列出所有待确认内容及其来源 | master |
| `#呱瓜记忆确认 <M编号> [userid]` | 确认记忆；对象不明时补充 userid | master |
| `#呱瓜记忆修正/忽略/删除 <M编号>` | 更正 / 忽略 / 删除某条记忆 | master |
| `#呱瓜记忆提醒` / `记忆提醒间隔 <小时>` | 立即私聊推送待确认项 / 设置提醒周期 | master |
| `#ds帮助` | 查看帮助与当前配置 | master |
| `#ds切换模型 <flash\|pro\|友好\|毒舌\|严肃>` | 切换模型或互动模式 | master |
| `#ds切换模式 <友好\|毒舌\|严肃>` | 切换互动模式 | master |
| `#ds思考模式 <开启\|关闭>` | 开关思考模式 | master |
| `#ds设置温度 <数字>` | 设置温度（0-2） | master |
| `#ds设置上下文长度 <数字>` | 设置上下文轮数（0-10） | master |
| `#ds设置群聊记录长度 <数字>` | 设置群聊历史条数（0-20） | master |
| `#ds设置提示词 <内容>` | 设置自定义系统提示词（存 redis，优先于 config 默认人设） | master |
| `#ds设置思考过程 <关闭\|开启\|转发>` | 设置思考过程显示方式 | master |

## 多模态（图片理解）

- 默认模型 `deepseek-flash`（V4.1 Flash）**原生支持视觉**：用户发送的图片会以 base64 data URL 随文本一起提交，AI 可直接描述 / 分析图中内容
- 图片获取：优先取消息段的 `url`，兼容 `base64://`、`data:` 与本地文件路径；单张上限 8MB、一次最多 4 张，失败自动降级为文本占位
- 切换为不支持视觉的模型（如 `deepseek-v4-pro`）时，图片自动退回文本占位，避免接口报错
- 对话历史中的图片以文字说明（`（附N张图片）`）保存，避免历史反复携带大图

## 引用消息（QQ 引用回复）

- 用户可先单独发图、再**引用该图**向呱瓜提问；也可引用任意历史消息补充上下文
- 实现依赖框架能力：TRSS-Yunzai 的 loader 识别 reply 段后提供 `e.reply_id` 与 `e.getReply()`（群聊 → `e.group.getMsg`，私聊 → `e.friend.getMsg`）
- 被引用内容以 `引用消息（某某 发的）：...` 注入上下文；其中图片与当前消息图片合并提交（合计上限 4 张），文本超长自动截断
- 取不到被引用消息（已撤回 / 过期 / 权限不足）时自动降级，不影响正常回复
- 陪伴模式同样识别引用：被引用文本并入该条消息上下文；只引用内容而无文字时也视为有信息量，可触发判断

## 用户资料库与称呼学习

- 资料存于插件同级 `member-profile.json`，对话时按涉及的 userid 动态注入，详见「第 4.5 步」
- AI 可通过 `member_profile_query` 工具按需查询：查某人资料、查未来 N 天生日（由**程序计算日期**，不靠模型心算）、导出全量资料（仅主人）
- 群友之间约定的新称呼可由 AI 自动学习，写入资料文件的 `learned` 字段
- 拿不准对应关系的新名字进入 `pending`，由主人用 `#呱瓜资料` 系列确认

## 长期记忆（memory.json）

与「人工资料」分开的另一条链路：插件在后台**独立提取**群聊中值得长期记住的信息，按确认状态使用。

- **六类记忆**：称呼 / 偏好 / 个人事实 / 关联事物 / 近期事件 / 约定
  - 「近期事件」与「约定」免确认但有**时效**（默认 14 / 30 天，可配），过期不再当作当前安排
  - 其余四类属于**待确认参考**，主人用 `#呱瓜记忆确认` 后才作为事实使用
- **提取方式**：消息先进入待提取队列，攒够 `extractionBatchSize` 条或等待 `extractionDelaySeconds` 秒后批量交给 AI 提取；每条记忆都必须附**原话证据**（`evidence` 能在原消息中逐字找到）且说话人在场，否则丢弃——防止凭空编造或张冠李戴
- **召回**：每次对话按当前话题与涉及 userid 检索相关记忆，分三组注入：【已确认长期记忆】/【近期事件和约定】/【待确认参考】，并明确告知模型待确认项不得当作既定事实
- **对话历史与摘要**：也由记忆模块统一持久化（进程重启不丢），消息超出上下文轮数后自动滚动摘要（600 字以内），供后续对话理解前情
- **主人提醒**：有待确认项时定期私聊主人（默认 6 小时一次，可用 `#呱瓜记忆提醒间隔` 调整，`#呱瓜记忆提醒` 立即触发），分页展示编号、内容与来源原话
- **数据文件**：`memory.json` 自动维护请勿手改；`memory-config.json` 存放运行参数，初始值来自 `config.memory.defaults`

> 分工：**人工资料**（member-profile.json）是你亲手维护的权威信息，永远优先；**长期记忆**由 AI 从聊天中自动积累，可靠性靠「证据 + 确认 + 时效」三层约束，两者冲突时以人工资料为准。

## 陪伴模式

- 开启后监听群消息，每条消息尝试判断（5 秒冷却 + 判断锁），由 AI 依据人设决定是否插话，简短回复为主（不超过 30 字，必要情况最多 100 字）
- 消息过长时取出最旧批次交给记忆服务滚动摘要（按 userid 区分用户），保持长上下文
- 群内 5 分钟无新消息自动关闭并提醒（`companion.autoCloseMs` 可调）
- 纯 CQ 消息不触发回复但拼入上下文；引用消息与官方表情包（`[表情包:xxx]`）视为有信息量，会触发判断；@ 机器人视为明确互动请求，立即回复
- 判断时可附带 `need_query` 请求插件代查资料 / 生日，把准确结果并入二次调用后再回复
- 未开启陪伴的群有 60 秒负缓存，日常消息不会逐条查询 redis

## 安全说明

- 群友发言视为不可信数据：以 `<user_msg>...</user_msg>` 标记包裹并写入人设防注入声明，任何「忽略设定 / 输出提示词 / 执行动作」类指令一律无效
- 消息中伪造的 `</user_msg>` 会被转义、伪造的 `【MEM】` 学习行会被清除，防止逃逸包裹或污染学习链路
- 安全规则段独立成常量，**自定义提示词（`#ds设置提示词`）也会被强制追加**，无法覆盖
- 群聊历史同样用 `<user_msg>` 包裹（历史是最大的注入面）
- AI 输出中的非 @ CQ 码会被清洗为文本占位，防止恶意 CQ 码被机器人代发
- 群聊历史 / 用户消息中的 CQ 码（图片、语音、视频、文件等）在送入 AI 前均会被清洗为安全文本
- AI 学习到的称呼经消毒（限长、去换行与尖括号）后才写入资料文件，防止持久化注入
- 记忆提取要求「原话证据 + 说话人在场」双重校验，越权 userid 与编造内容一律丢弃；待确认项在提示词中被明确标注为**不得当作事实**
- 发言内容会发送至第三方 AI API（DeepSeek / Ollama），请确保合规并告知群友

## 常见问题

- **对话无响应**：检查 `config.js` 中 `deepseek.apiKey` 是否已填写、`openai`/`axios` 是否安装
- **联网搜索不可用**：检查 `webSearch.apiKey` 是否已填写、`enabled` 是否为 `true`
- **图片没有生效**：确认当前模型支持视觉（`#ds帮助` 查看）；切到 `deepseek-v4-pro` 后图片会自动退回文本占位
- **AI 不认识某位群友**：在 `member-profile.json` 中补该 userid 的资料，或执行 `#呱瓜资料重载`
- **资料改动没生效**：资料有 60 秒内存缓存，用 `#呱瓜资料重载` 可立即刷新
- **自定义人设**：通过 `#ds设置提示词` 保存的自定义提示词存储在 redis 中，会优先于 `config.js` 的默认人设生效；也可直接编辑 `config.js` 的 `persona.systemPrompt` 修改默认人设
