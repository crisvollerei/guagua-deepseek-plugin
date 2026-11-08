// 只读诊断：执行主插件原有查询函数，所有存储写入均发生在 tests/.tmp 的隔离目录。
// 不加载主插件的模型客户端，不访问网络，不修改实际资料或记忆。
import * as fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { MemoryService, sessionKey, normalizeId } from '../guagua-memory.mjs';
import { config } from '../config.js';

const base = fileURLToPath(new URL('./.tmp/', import.meta.url));
fs.mkdirSync(base, { recursive: true });
const root = fs.mkdtempSync(path.join(base, 'guagua-isolation-probe-'));
const profile = { users: {
    '33333': { name: '本群甲', birthday: '1月1日', groups: { '11111': { note: '甲群备注' }, '22222': {} }, aliases: [], learned: [] },
    '55555': { name: '外群乙', birthday: '2月2日', groups: { '22222': { note: '乙群备注' } }, aliases: [], learned: [] }
}, pending: [] };
const quiet = { error() {}, warn() {}, info() {} };
const memory = new MemoryService({ directory: root, getProfile: () => profile, logger: quiet,
    now: () => Date.parse('2026-10-16T08:00:00Z'), complete: async () => { throw Error('诊断禁止模型调用'); } });

try {
    const sourceCode = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
    const section = (start, end) => {
        const from = sourceCode.indexOf(start), to = sourceCode.indexOf(end, from);
        if (from < 0 || to <= from) throw Error('查询函数位置已变化，请检查诊断脚本');
        return sourceCode.slice(from, to);
    };
    const sandbox = { memory, normalizeId, config, loadProfile: () => profile };
    vm.createContext(sandbox);
    vm.runInContext(section('function getUserByUid(', '// 解析回复末尾的学习元数据行') +
        section('function parseBirthdayText(', '// ==================== 多模态图片') +
        '\nthis.query = executeProfileQuery;', sandbox);

    const contexts = {};
    for (const gid of ['11111', '22222']) {
        memory.roster.noteMessage({ self_id: 12345, group_id: gid, user_id: 33333, post_type: 'message' });
        contexts[gid] = memory.roster.context({ self_id: 12345, group_id: gid }, ['33333']);
    }
    const query = (action, target, days, gid, master) => sandbox.query(action, target, days, gid, master, contexts[gid]);
    const event = group => ({ self_id: 12345, user_id: 33333, group_id: group, message: [] });
    const a = sessionKey(event(11111)), b = sessionKey(event(22222));
    memory.store.appendHistory(a, [{ role: 'user', content: '甲群独有对话' }], 3);
    memory.store.change(data => { data.sessions[a].summary = '甲群独有摘要'; });

    const source = { id: 'probe-message', speakerId: '33333', groupId: '11111', session: a,
        at: '2026-10-16T08:00:00Z', text: '叫我甲群外号；明天甲群一起复习；我有一只猫叫豆包', targets: [] };
    memory.ingest([
        { type: 'alias', userid: '33333', content: '甲群外号', scope: 'group', source_id: source.id, evidence: '叫我甲群外号' },
        { type: 'event', userid: '33333', content: '明天甲群一起复习', assertion: 'affirmed', source_id: source.id, evidence: '明天甲群一起复习' },
        { type: 'entity', userid: '33333', content: '有一只猫叫豆包', scope: 'global', source_id: source.id, evidence: '我有一只猫叫豆包' }
    ], [source]);
    const recalled = memory.context({ ...contexts['22222'], userIds: ['33333'], groupId: '22222', query: '甲群外号，明天复习，豆包' });
    memory.observe({ ...event(11111), message_id: 'card-a', sender: { card: '甲群名片', nickname: 'QQ昵称' } }, '甲群消息');
    memory.observe({ ...event(22222), message_id: 'card-b', sender: { card: '乙群名片', nickname: 'QQ昵称' } }, '乙群消息');

    const results = {
        conversationIsolated: a !== b && memory.store.history(b, 3).length === 0 && memory.store.summary(b, 3) === '',
        groupAliasIsolated: !recalled.includes('甲群外号'),
        samePersonsStableMemoryShared: recalled.includes('豆包'),
        eventWithoutScopeStaysInSourceGroup: !recalled.includes('明天甲群一起复习') && memory.context(contexts['11111']).includes('明天甲群一起复习'),
        unrelatedGroupMemberNotFound: !query('user_info', '55555', 7, '11111', false).includes('生日:2月2日'),
        birthdayListLimitedToCurrentGroup: !query('upcoming_birthdays', '', 365, '11111', false).includes('外群乙'),
        missingUserResponseLimitedToCurrentGroup: !query('user_info', '不存在的名字', 7, '11111', false).includes('外群乙'),
        masterExportInGroupLimitedToCurrentGroup: !query('full_export', '', 7, '11111', true).includes('外群乙'),
        groupCardNamesKeptSeparate: memory.memberName('33333', '11111') === '甲群名片' && memory.memberName('33333', '22222') === '乙群名片' && memory.store.data.people['33333'].name === 'QQ昵称'
    };
    console.log(JSON.stringify(results, null, 2));
    assert.ok(Object.values(results).every(Boolean), '按人共用稳定信息、按会话隔离临时信息的验证失败');
} finally {
    memory.dispose();
    const absolute = path.resolve(root);
    if (path.dirname(absolute) !== path.resolve(base) || !path.basename(absolute).startsWith('guagua-isolation-probe-')) throw Error('诊断临时目录校验失败');
    fs.rmSync(absolute, { recursive: true, force: true });
}
