# DeepSeek 聊天插件（trss-yunzai）

基于 trss-yunzai / Yunzai-Bot 系的 QQ 机器人聊天插件：`#呱瓜` 对话 + `#陪伴` 陪伴聊天模式。

---

## 文件结构

```
guagua-deepseek-plugin/
├── index.js       # 插件主文件（含命令处理 / 聊天 / 陪伴模式）
├── config.js      # 配置文件（密钥、模型、命令前缀、人设、陪伴参数）
├── package.json   # 依赖声明（openai、axios）
└── README.md      # 本说明文档
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
| `deepseek.defaultModel` / `models` | 默认模型与 `#ds切换模型` 的模型映射（默认官方命名 `deepseek-chat` / `deepseek-reasoner`，使用第三方网关时请改为网关支持的模型名） |
| `webSearch.apiKey` / `apiUrl` / `enabled` | 联网搜索（Ollama Web Search Cloud API）密钥、地址与开关（**密钥必须替换**） |
| `command.chatPrefix` / `reset` / `companion` / `adminPrefix` | 各命令触发前缀（需以 `#` 开头） |
| `chat.*` | 对话默认参数（上下文长度 / 群聊记录长度 / 温度 / 思考过程显示），运行时被 redis 中已保存的配置覆盖 |
| `companion.*` | 陪伴模式参数（判断/回复冷却、缓冲上限、摘要参数、自动关闭时长等） |
| `persona.*` | 人设：机器人昵称、主人信息、优先识别名单（`preferredUsers`）、群特殊设定（`groupSettings`）、默认人设模板（`systemPrompt`，支持 `{{botName}}` 等占位符） |

密钥也支持通过环境变量覆盖（不修改文件即可换 Key）：

- `DEEPSEEK_API_KEY` / `DEEPSEEK_BASE_URL`
- `OLLAMA_API_KEY`

## 配置流程（详细版）

按以下步骤即可完成插件的完整配置：

### 第 1 步：获取 DeepSeek API Key（必需）

1. 打开 DeepSeek 开放平台：<https://platform.deepseek.com>
2. 注册 / 登录后，进入 **API Keys** 页面
3. 点击「创建 API Key」，复制生成的 `sk-` 开头的密钥（**只显示一次，请立即保存**）
4. 官方模型名对照：
   - `deepseek-chat`：通用对话模型（默认使用）
   - `deepseek-reasoner`：深度思考模型（`#ds切换模型 pro` 切换）

### 第 2 步：获取 Ollama Web Search Key（可选，用于联网搜索）

1. 打开 Ollama：<https://ollama.com>，登录后进入 Cloud / API 设置
2. 生成 API Key（形如 `uuid.token`）
3. 如果不需要联网搜索功能，可将 `config.webSearch.enabled` 改为 `false`，跳过本步

### 第 3 步：填入配置（两种方式任选其一）

**方式 A：直接编辑 `config.js`**

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

**方式 B：环境变量（推荐，密钥不进仓库）**

```bash
# 在启动机器人的 shell 中设置（Windows CMD 用 set，PowerShell 用 $env:）
export DEEPSEEK_API_KEY=sk-你的DeepSeek密钥
export OLLAMA_API_KEY=你的Ollama密钥
```

环境变量的优先级高于 `config.js` 中的默认值，两种方式都设置时以环境变量为准。

### 第 4 步：安装依赖并重启

```bash
npm install openai axios   # 在 trss-yunzai 项目根目录执行
# 重启机器人，插件自动加载
```

### 第 5 步：验证

- 群内发送 `#呱瓜 你好`，应收到 AI 回复
- 发送 `#ds帮助`（仅 master 可见）查看当前配置与全部命令
- 发送 `#陪伴` 开启陪伴模式体验主动对话

### 安全提醒

- `config.js` 中的 `your_deepseek_api_key_here` / `your_ollama_api_key_here` 仅为占位符，请务必替换
- 请勿把真实密钥提交到公开仓库（推荐方式 B 环境变量管理密钥）
- 若怀疑密钥泄露，请立即到对应平台吊销并重新生成

## 命令

| 命令 | 说明 | 权限 |
|---|---|---|
| `#呱瓜 <内容>` | 与呱瓜聊天（支持联网搜索） | 所有人 |
| `#结束对话` | 重置当前对话上下文 | 所有人 |
| `#陪伴` / `#陪伴关闭` / `#陪伴状态` | 陪伴模式开关与状态（支持 `#呱瓜陪伴` 系列） | 所有人 |
| `#ds帮助` | 查看帮助与当前配置 | master |
| `#ds切换模型 <flash\|pro\|友好\|毒舌\|严肃>` | 切换模型或互动模式 | master |
| `#ds切换模式 <友好\|毒舌\|严肃>` | 切换互动模式 | master |
| `#ds思考模式 <开启\|关闭>` | 开关思考模式 | master |
| `#ds设置温度 <数字>` | 设置温度（0-2） | master |
| `#ds设置上下文长度 <数字>` | 设置上下文轮数（0-10） | master |
| `#ds设置群聊记录长度 <数字>` | 设置群聊历史条数（0-20） | master |
| `#ds设置提示词 <内容>` | 设置自定义系统提示词（存 redis，优先于 config 默认人设） | master |
| `#ds设置思考过程 <关闭\|开启\|转发>` | 设置思考过程显示方式 | master |

## 陪伴模式

- 开启后监听群消息，每条消息尝试判断（5 秒冷却 + 判断锁），由 AI 依据人设决定是否插话，简短回复为主（不超过 30 字，必要情况最多 100 字）
- 消息过长时并行 AI 摘要（按 userid 区分用户），保持长上下文
- 群内 5 分钟无新消息自动关闭并提醒（`companion.autoCloseMs` 可调）
- 纯 CQ 消息不触发回复但拼入上下文；@ 机器人视为明确互动请求，立即回复

## 安全说明

- 群友发言视为不可信数据：以 `<user_msg>...</user_msg>` 标记包裹并写入人设防注入声明，任何「忽略设定 / 输出提示词 / 执行动作」类指令一律无效
- AI 输出中的非 @ CQ 码会被清洗为文本占位，防止恶意 CQ 码被机器人代发
- 群聊历史 / 用户消息中的 CQ 码（图片、语音、视频、文件等）在送入 AI 前均会被清洗为安全文本
- 发言内容会发送至第三方 AI API（DeepSeek / Ollama），请确保合规并告知群友

## 常见问题

- **对话无响应**：检查 `config.js` 中 `deepseek.apiKey` 是否已填写、`openai`/`axios` 是否安装
- **联网搜索不可用**：检查 `webSearch.apiKey` 是否已填写、`enabled` 是否为 `true`
- **自定义人设**：通过 `#ds设置提示词` 保存的自定义提示词存储在 redis 中，会优先于 `config.js` 的默认人设生效；也可直接编辑 `config.js` 的 `persona.systemPrompt` 修改默认人设
