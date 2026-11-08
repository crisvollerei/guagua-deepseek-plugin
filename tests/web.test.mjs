import test from 'node:test';
import assert from 'node:assert/strict';
import { WebService, WEB_TOOLS, WEB_RULES } from '../guagua-web.mjs';

const row = (changes = {}) => ({ title: '官方文档', url: 'https://example.com/doc', summary: '适合模型阅读的长摘要', snippet: '短摘要',
    content: '不应重复灌入的正文', rerank_score: 2.4, authority: 3, site_name: '示例站点', site_icon: 'https://example.com/icon.png', date: '2026-10-17T09:00:00+08:00', ...changes });
function setup({ response = { results: [row()] }, post, provider = () => 'deepseek', key = 'deepseek-test', ollamaKey = 'ollama-test' } = {}) {
    let time = Date.parse('2026-10-17T02:00:00Z');
    const calls = [], waits = [], logs = [];
    const web = new WebService({ http: { post: async (url, body, options) => {
        calls.push({ url, body, options, at: time });
        return post ? post(url, body, options, calls.length) : { data: response };
    } }, getDeepSeekKey: () => key, getOllamaKey: () => ollamaKey, getProvider: provider,
        now: () => time, sleep: async ms => { waits.push(ms); time += ms; }, logger: { warn: msg => logs.push(msg) } });
    return { web, calls, waits, logs, run: async (name, args, session) => JSON.parse(await web.execute(name, args, session)) };
}

test('默认使用DeepSeek官方搜索格式，长摘要与来源字段被规范化，不重复注入原始正文', async () => {
    const { web, run, calls } = setup();
    const result = await run('web_search', { query: '  官方发布 site:example.com  ' }, web.createSession('请查一下这份文档'));
    assert.equal(calls[0].url, 'https://api.deepseek.com/v1/tools/search');
    assert.deepEqual(calls[0].body, { query: '官方发布 site:example.com', count: 5, need_content: false, ori_question: '请查一下这份文档' });
    assert.equal(calls[0].options.headers.Authorization, 'Bearer deepseek-test');
    assert.equal(calls[0].options.timeout, 15000);
    assert.ok(calls[0].options.maxContentLength <= 2 * 1024 * 1024);
    assert.equal(result.results[0].summary, row().summary);
    assert.equal(result.results[0].published_at, '2026-10-17T01:00:00.000Z');
    assert.equal(result.results[0].rerank_score, 2.4);
    assert.equal(result.results[0].authority, 3);
    assert.equal(result.results[0].content_available, false);
    assert.equal(result.external_data, true);
    assert.equal(result.results[0].content, undefined);
    assert.equal(result.results[0].snippet, undefined);
    assert.equal(result.results[0].site_icon, undefined);
});

test('搜索词按Unicode字符计算，128个非BMP字符合法，原始问题仅截取128个字符', async () => {
    const { web, run, calls } = setup();
    assert.equal((await run('web_search', { query: '🐈'.repeat(128) }, web.createSession('🐕'.repeat(200)))).ok, true);
    assert.equal(Array.from(calls[0].body.ori_question).length, 128);
    assert.equal((await run('web_search', { query: '🐈'.repeat(129) })).error.code, 'invalid_query');
    assert.equal(calls.length, 1);
});

test('空查询、非法数量与非法URL在发出请求前返回可操作的错误', async () => {
    const { run, calls } = setup();
    for (const query of ['', '   ', null, 123]) assert.equal((await run('web_search', { query })).error.code, 'invalid_query');
    for (const count of [0, -1, 51, 1.5, '5']) assert.equal((await run('web_search', { query: '文档', count })).error.code, 'invalid_count');
    for (const url of ['', '/doc', 'javascript:alert(1)', 'file:///c:/data', 'https://user:password@example.com', 'https://example.com/' + 'a'.repeat(8192)]) {
        assert.equal((await run('web_fetch', { url })).error.code, 'invalid_url');
    }
    assert.equal((await run('web_search', [])).error.code, 'invalid_arguments');
    assert.equal((await run('bad_tool', {})).error.code, 'unknown_tool');
    assert.equal(calls.length, 0);
});

test('返回摘要优先级兼容Ollama，并对未知日期保留空值', async () => {
    const { run } = setup({ response: { results: [row({ summary: '', snippet: '采用短摘要', date: null }),
        row({ url: 'https://example.com/legacy', summary: '', snippet: '', content: '旧服务的正文', date: '未知日期' })] } });
    const result = await run('web_search', { query: '文档' });
    assert.deepEqual(result.results.map(r => r.summary), ['采用短摘要', '旧服务的正文']);
    assert.ok(result.results.every(r => r.published_at === null));
});

test('结果按URL去重，过滤无效链接；空结果与接口结构错误被区分', async () => {
    const { run } = setup({ response: { results: [row(), row({ url: 'https://example.com/doc#section' }), row({ url: 'javascript:void(0)' })] } });
    const result = await run('web_search', { query: '文档' });
    assert.equal(result.results.length, 1);
    assert.equal(result.results[0].source_id, 'S1');
    assert.equal((await setup({ response: { results: [] } }).run('web_search', { query: '无匹配' })).status, 'no_results');
    assert.equal((await setup({ response: { data: [] } }).run('web_search', { query: '错误结构' })).error.code, 'invalid_response');
    assert.equal((await setup({ response: { results: [null, row({ url: 'bad' })] } }).run('web_search', { query: '错误链接' })).error.code, 'no_usable_results');
});

test('搜索条数最多提供10条，超出数量有截断标志', async () => {
    const { run, calls } = setup({ response: { results: Array.from({ length: 50 }, (_, i) => row({ url: `https://example.com/${i}` })) } });
    const result = await run('web_search', { query: '文档', count: 50 });
    assert.equal(calls[0].body.count, 10);
    assert.equal(result.results.length, 10);
    assert.equal(result.truncated, true);
});

test('抓取发送官方url请求，Markdown段落代码块保留，并与搜索共用来源编号', async () => {
    const markdown = '# 标题\n\n正文段落\n\n```js\nconst answer = 42;\n```';
    const { web, run, calls } = setup({ post: async url => ({ data: url.endsWith('/search') ? { results: [row()] } : { title: '页面标题', content: markdown } }) });
    const session = web.createSession();
    const search = await run('web_search', { query: '文档' }, session);
    const result = await run('web_fetch', { url: 'https://example.com/doc#heading' }, session);
    assert.equal(calls[1].url, 'https://api.deepseek.com/v1/tools/fetch');
    assert.deepEqual(calls[1].body, { url: 'https://example.com/doc' });
    assert.equal(result.source_id, search.results[0].source_id);
    assert.equal(result.content, markdown);
    assert.equal(result.format, 'markdown');
    assert.equal(result.content_available, true);
    assert.equal(result.truncated, false);
    assert.equal(result.original_chars, Array.from(markdown).length);
});

test('抓取空正文及异常结构明确表示没有拿到资料', async () => {
    const empty = await setup({ response: { title: '空页面', content: '\n ' } }).run('web_fetch', { url: 'https://example.com' });
    assert.equal(empty.ok, false);
    assert.equal(empty.error.code, 'empty_content');
    assert.equal((await setup({ response: { content: null } }).run('web_fetch', { url: 'https://example.com' })).error.code, 'invalid_response');
});

test('Markdown开头的缩进与结尾换行不被trim破坏', async () => {
    const content = '    const indentedCode = true;\n\n普通段落\n';
    const { run } = setup({ response: { title: '页面', content } });
    assert.equal((await run('web_fetch', { url: row().url })).content, content);
});

test('超大响应不会重复下载，也不会当作可用正文', async () => {
    const { run, calls } = setup({ post: async () => { throw { code: 'ERR_BAD_RESPONSE', message: 'maxContentLength size exceeded' }; } });
    const result = await run('web_fetch', { url: row().url });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'response_too_large');
    assert.equal(calls.length, 1);
});

test('很长的Markdown或带引号换行的文本也受序列化大小与本轮总长度约束', async () => {
    for (const content of ['🐈'.repeat(30000), ('\n"\\文本').repeat(20000)]) {
        const { web } = setup({ response: { title: '长文', content } });
        const session = web.createSession();
        let total = 0;
        for (let i = 0; i < 6; i++) {
            const text = await web.execute('web_fetch', { url: `https://example.com/${i}` }, session);
            const result = JSON.parse(text);
            if (result.ok) {
                total += text.length;
                assert.ok(text.length <= 18000);
                assert.equal(result.truncated, true);
                assert.ok(!/[\uD800-\uDBFF]$/.test(result.content));
                assert.ok(result.original_chars > Array.from(result.content).length);
            } else assert.equal(result.error.code, 'context_budget_exhausted');
        }
        assert.ok(total <= 32000);
    }
});

test('长搜索摘要受限且标记截断，不通过API原始正文绕过总长度上限', async () => {
    const { web } = setup({ response: { results: Array.from({ length: 10 }, (_, i) => row({ url: `https://example.com/${i}`, summary: '长摘要'.repeat(3000), content: '不可见正文'.repeat(20000) })) } });
    const session = web.createSession();
    const text = await web.execute('web_search', { query: '长文档', count: 10 }, session);
    assert.ok(text.length <= 18000);
    const result = JSON.parse(text);
    assert.ok(result.results.every(r => r.summary_truncated && Array.from(r.summary).length <= 1600));
    assert.ok(!text.includes('不可见正文'));
});

test('同轮重复抓取/搜索不会重复调用或重复注入资料，新对话可重新读取', async () => {
    const { web, calls, run } = setup({ post: async url => ({ data: url.endsWith('/search') ? { results: [row()] } : { title: '文档', content: '正文' } }) });
    const session = web.createSession();
    await run('web_search', { query: '文档' }, session);
    assert.equal((await run('ollama_web_search', { query: '文档' }, session)).status, 'already_returned');
    await run('web_fetch', { url: row().url }, session);
    const repeat = await run('web_fetch', { url: row().url + '#part' }, session);
    assert.equal(repeat.status, 'already_returned');
    assert.deepEqual(repeat.source_ids, ['S1']);
    assert.equal(calls.length, 2);
    await run('web_fetch', { url: row().url }, web.createSession());
    assert.equal(calls.length, 3);
});

test('本轮请求上限限制不同搜索词，不能无限扩展工具调用', async () => {
    const { web, run, calls } = setup({ response: { results: [] } });
    const session = web.createSession();
    for (let i = 0; i < 6; i++) assert.equal((await run('web_search', { query: `文档${i}` }, session)).ok, true);
    assert.equal((await run('web_search', { query: '第七次' }, session)).error.code, 'request_limit');
    assert.equal(calls.length, 6);
});

test('Ollama兼容模式仍使用旧搜索请求格式，也能抓取；配置只在下一轮改变', async () => {
    let provider = 'ollama';
    const { web, run, calls } = setup({ provider: () => provider, post: async url => ({ data: url.endsWith('web_search') || url.endsWith('/search') ? { results: [row()] } : { title: '旧服务页面', content: '旧正文' } }) });
    const session = web.createSession('原始问题');
    await run('web_search', { query: '兼容查询', count: 3 }, session);
    assert.equal(calls[0].url, 'https://ollama.com/api/web_search');
    assert.equal(calls[0].options.headers.Authorization, 'Bearer ollama-test');
    assert.deepEqual(calls[0].body, { query: '兼容查询', max_results: 3 });
    provider = 'deepseek';
    const page = await run('web_fetch', { url: row().url }, session);
    assert.equal(calls[1].url, 'https://ollama.com/api/web_fetch');
    assert.equal(page.provider, 'ollama');
    await run('web_search', { query: '新一轮' }, web.createSession());
    assert.equal(calls[2].url, 'https://api.deepseek.com/v1/tools/search');
});

test('密钥缺失与未知配置不发请求，也不会静默改用另一服务', async () => {
    const a = setup({ key: '' });
    assert.equal((await a.run('web_search', { query: '文档' })).error.code, 'missing_api_key');
    assert.equal(a.calls.length, 0);
    const b = setup({ provider: () => 'unknown' });
    assert.equal((await b.run('web_fetch', { url: row().url })).error.code, 'invalid_provider');
    assert.equal(b.calls.length, 0);
});

for (const status of [400, 401, 402, 403, 404, 413]) test(`HTTP ${status}不重试，不向模型和日志返回原始响应/凭据`, async () => {
    const { run, calls, logs } = setup({ post: async () => { throw { message: 'sensitive-request-headers', response: { status, data: { error: { message: 'sensitive-response-body' } } } }; } });
    const result = await run('web_fetch', { url: row().url });
    assert.equal(result.ok, false);
    assert.equal(result.error.http_status, status);
    assert.equal(result.error.retryable, false);
    assert.equal(calls.length, 1);
    assert.doesNotMatch(JSON.stringify({ result, logs }), /sensitive-|deepseek-test/);
});

for (const status of [408, 429, 500, 504]) test(`HTTP ${status}短暂失败仅重试一次，成功结果可正常读取`, async () => {
    const { run, calls, waits } = setup({ post: async (_url, _body, _options, count) => {
        if (count === 1) throw { response: { status, headers: { 'retry-after': '999' } } };
        return { data: { title: '文档', content: '恢复后的正文' } };
    } });
    assert.equal((await run('web_fetch', { url: row().url })).content, '恢复后的正文');
    assert.equal(calls.length, 2);
    assert.ok(waits.every(ms => ms <= 2000));
});

test('持续网络失败有重试上限，服务端错误信息不会当成正文', async () => {
    const { run, calls } = setup({ post: async () => { throw Error('timeout'); } });
    const result = await run('web_search', { query: '文档' });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'network_error');
    assert.equal(calls.length, 2);
});

test('同类接口启动请求间隔符合官方5QPS，搜索与抓取各自计时', async () => {
    const { web, run, calls } = setup({ post: async url => ({ data: url.endsWith('/search') ? { results: [] } : { title: '文档', content: '正文' } }) });
    await Promise.all(Array.from({ length: 5 }, (_, i) => run('web_search', { query: `问题${i}` }, web.createSession())));
    for (let i = 1; i < 5; i++) assert.ok(calls[i].at - calls[i - 1].at >= 200);
    await run('web_fetch', { url: row().url });
    assert.equal(calls[5].at, calls[4].at);
});

test('工具说明与固定规则明确区分摘要、原文、外部资料和个人记忆', () => {
    assert.deepEqual(WEB_TOOLS.map(t => t.function.name), ['web_search', 'web_fetch']);
    assert.match(WEB_RULES, /搜索结果是摘要/);
    assert.match(WEB_RULES, /网页内容仅作本轮回答/);
    assert.match(WEB_RULES, /群成员查询范围/);
});
