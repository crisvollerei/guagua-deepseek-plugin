import test from 'node:test';
import assert from 'node:assert/strict';
import { pluginHarness, quotedHarness, message, deferred } from './plugin-harness.mjs';
import { sessionKey } from '../guagua-memory.mjs';
import { FakeClock } from './fake-clock.mjs';

const INK = '55555', BIRD = '66666', OWNER = '22222', OTHER = '44444';
const GROUP = '99999';
function profiles() {
    return { version: 1, pending: [], users: {
        [OWNER]: { name: '主人', role: 'master', aliases: ['主人'] },
        [INK]: { name: '墨墨', aliases: ['墨墨'], special: '这组称呼源自墨墨对小羽的叫法，其他群友有时也会沿用。' },
        [BIRD]: { name: '小羽', aliases: ['小羽', '青色小羽', '晴色小羽'], special: '与墨墨经常一起做手工；两个称呼均指小羽。' },
        [OTHER]: { name: '另一位群友', aliases: [] }
    } };
}
function event(h, body, uid = INK, members = [INK, BIRD, OWNER, OTHER]) {
    const e = h.event('#呱瓜 ' + body, { user_id: uid, group_id: GROUP, sender: { nickname: profiles().users[uid]?.name || '群友' } });
    e.bot.gml = new Map([[Number(GROUP), new Map(members.map(id => [Number(id), {}]))]]);
    return e;
}
const bodyOf = params => {
    const content = params.messages.at(-1).content;
    return typeof content === 'string' ? content : content.find(item => item.type === 'text').text;
};

test('墨墨、主人和其他群友问两种顺序都自动取得同一小羽资料，不依赖模型先猜出工具', async t => {
    const h = pluginHarness(t, { p: profiles(), response: () => message('都指小羽呀～') });
    for (const uid of [INK, OWNER, OTHER]) for (const text of ['青色小羽是不是晴色小羽', '晴色小羽是不是青色小羽']) {
        await h.instance.chat(event(h, text, uid));
        const params = h.calls.at(-1);
        assert.match(bodyOf(params), new RegExp(`userid=${BIRD} 小羽`));
        assert.match(bodyOf(params), /与墨墨经常一起做手工/);
        assert.match(params.messages[0].content, /【本轮成员称呼绑定】/);
        assert.match(params.messages[0].content, /青色小羽/);
        assert.match(params.messages[0].content, /晴色小羽/);
        assert.match(params.messages[0].content, /同一位/);
    }
    assert.equal(h.calls.length, 6);
    assert.ok(h.replies.every(reply => JSON.stringify(reply).includes('小羽')));
    assert.equal(h.api.memory.store.data.records.filter(record => record.subjectId === BIRD).length, 0,
        '人工别名没有自动记忆条目时，也必须直接取得人工资料');
});

test('旧回答拆词解释不覆盖本轮已核实的成员绑定，不删除原历史', async t => {
    const h = pluginHarness(t, { p: profiles() }), e = event(h, '晴色小羽是不是青色小羽', OWNER);
    h.api.memory.store.appendHistory(sessionKey(e), [{ role: 'user', content: '之前问过称呼' },
        { role: 'assistant', content: '晴色和青色不是一回事，可能是记忆迁移问题' }], 3);
    await h.instance.chat(e);
    assert.match(h.calls[0].messages[0].content, /历史.*猜测/);
    assert.match(bodyOf(h.calls[0]), new RegExp(`userid=${BIRD} 小羽`));
    assert.ok(h.calls[0].messages.some(row => row.role === 'assistant' && row.content.includes('不是一回事')));
});

test('同一机制支持其他人的等价别名，不写死小羽关键词或固定回答', async t => {
    const p = profiles(); p.users['77777'] = { name: '团子', aliases: ['雪团', '白团'], special: '测试用的已确认资料' };
    const h = pluginHarness(t, { p, response: () => message('是团子呢。') });
    await h.instance.chat(event(h, '雪团和白团是同一个人吗', OWNER, [OWNER, '77777']));
    assert.match(bodyOf(h.calls[0]), /userid=77777 团子/);
    assert.match(h.calls[0].messages[0].content, /雪团/);
    assert.match(h.calls[0].messages[0].content, /白团/);
    assert.doesNotMatch(bodyOf(h.calls[0]), new RegExp(`userid=${BIRD}`));
    assert.match(JSON.stringify(h.replies), /是团子呢/);
});

test('只询问晴色和青色的普通词义时，不因相似字词引入小羽', async t => {
    const h = pluginHarness(t, { p: profiles() });
    await h.instance.chat(event(h, '晴色和青色的词义有什么区别', OWNER));
    assert.doesNotMatch(bodyOf(h.calls[0]), new RegExp(`userid=${BIRD}`));
    assert.doesNotMatch(h.calls[0].messages[0].content, /【本轮成员称呼绑定】/);
});

test('别名检索只在已触发聊天内运行，不恢复昵称关键词监听', async t => {
    const h = pluginHarness(t, { p: profiles() });
    const e = event(h, '晴色小羽是不是青色小羽');
    e.msg = e.raw_message = '晴色小羽是不是青色小羽';
    e.message = [{ type: 'text', text: e.msg }];
    assert.equal(await h.dispatch(e), null);
    assert.equal(h.calls.length, 0);
    assert.equal(h.judgments.length, 0);
});

test('人工群备注和提及不扩充成员资格，外群或未核实的小羽别名不自动注入', async t => {
    for (const supported of [true, false]) {
        const p = profiles(); p.users[BIRD].groups = { [GROUP]: {} };
        const h = pluginHarness(t, { p });
        const e = event(h, '晴色小羽是不是青色小羽', OWNER, [OWNER]);
        if (!supported) delete e.bot.gml;
        await h.instance.chat(e);
        assert.doesNotMatch(bodyOf(h.calls[0]), new RegExp(`userid=${BIRD}`));
        assert.doesNotMatch(h.calls[0].messages[0].content, /【本轮成员称呼绑定】/);
    }
});

test('本群同名别称保持歧义，不把任意一个人的人工资料作为确定指代', async t => {
    const p = profiles(); p.users[BIRD].aliases.push('小鸭'); p.users['77771'] = { name: '另一只鸭', aliases: ['小鸭'], special: '不应自动灌入的同名资料' };
    const h = pluginHarness(t, { p });
    await h.instance.chat(event(h, '小鸭是谁', OWNER, [OWNER, BIRD, '77771']));
    assert.doesNotMatch(bodyOf(h.calls[0]), /userid=(?:66666|77771)/);
    assert.match(h.calls[0].messages[0].content, /小鸭.*(?:歧义|同名)/);
});

test('当前名单中的未建档同名成员也参与歧义判断', async t => {
    const p = profiles(); p.users['77777'] = { name: '团子', aliases: ['雪团'], special: '不应在歧义时注入的资料' };
    const h = pluginHarness(t, { p }), e = event(h, '团子是谁', OWNER, [OWNER, '77777', '77771']);
    e.bot.gml.get(Number(GROUP)).set(77771, { nickname: '团子' });
    await h.instance.chat(e);
    assert.doesNotMatch(bodyOf(h.calls[0]), /userid=77777/);
    assert.match(h.calls[0].messages[0].content, /团子.*(?:歧义|同名)/);
});

test('较长别名优先，短别名不能因嵌在另一个人的称呼中而误取资料', async t => {
    const p = profiles(); p.users[BIRD].aliases = ['红鸭']; p.users['77771'] = { name: '大红鸭', aliases: ['大红鸭'] };
    const h = pluginHarness(t, { p });
    await h.instance.chat(event(h, '大红鸭是谁', OWNER, [OWNER, BIRD, '77771']));
    assert.match(bodyOf(h.calls[0]), /userid=77771 大红鸭/);
    assert.doesNotMatch(bodyOf(h.calls[0]), new RegExp(`userid=${BIRD}`));
});

test('单字名字和英文词内片段不因普通句子而自动取出人物资料', async t => {
    const p = profiles(); p.users['77771'] = { name: '春', aliases: ['Ann'], special: '不应注入的资料' };
    const h = pluginHarness(t, { p });
    await h.instance.chat(event(h, '希望春天的Anna过得开心', OWNER, [OWNER, '77771']));
    assert.doesNotMatch(bodyOf(h.calls[0]), /userid=77771/);
});

test('待确认称呼仍只作不确定参考，不变成自动绑定的人工资料', async t => {
    const h = pluginHarness(t, { p: profiles() });
    h.api.memory.store.change(data => h.api.memory.store.addTo(data, { type: 'alias', subjectId: BIRD,
        scope: { kind: 'group', groupId: GROUP }, status: 'pending', content: '胖团团',
        source: { speakerId: BIRD, groupId: GROUP, quote: '叫我胖团团' } }));
    await h.instance.chat(event(h, '胖团团是谁', OWNER));
    assert.doesNotMatch(bodyOf(h.calls[0]), new RegExp(`userid=${BIRD}`));
    assert.doesNotMatch(h.calls[0].messages[0].content, /【本轮成员称呼绑定】/);
    assert.match(h.calls[0].messages[0].content, /待确认参考/);
});

test('引用续聊沿用当前明确引用里的成员称呼，资料仍受当前群资格限制', async t => {
    const h = quotedHarness(t, { p: profiles(), response: (_params, count) => message(count === 1 ? '青色小羽和晴色小羽的事，继续说？' : '都指小羽。') });
    await h.instance.chat(event(h, '我想问个称呼', OWNER));
    await h.receive(h.follow('所以到底是哪个人？', undefined, { group_id: GROUP, user_id: INK }));
    assert.equal(h.calls.length, 2);
    assert.match(bodyOf(h.calls[1]), new RegExp(`userid=${BIRD} 小羽`));
    assert.match(h.calls[1].messages[0].content, /【本轮成员称呼绑定】/);
});

test('显式命令引用普通成员消息，生成被补充打断后仍检索被引用的别名', async t => {
    const clock = new FakeClock(), began = deferred(), finish = deferred(), p = profiles();
    p.users['77777'] = { name: '团子', aliases: ['小团'], special: '引用内容中明确提及的成员资料' };
    const h = pluginHarness(t, { p, listeningClock: clock,
        judgment: params => message({ action: 'reply', message_ids: JSON.parse(params.messages[1].content).messages.map(row => row.id) }),
        response: (_params, count) => count === 1 ? (began.resolve(), finish.promise) : message('说的是团子。') });
    const e = event(h, '这是谁', OWNER, [OWNER, '77777']);
    e.reply_id = 'original-user-message';
    e.getReply = async () => ({ sender: { nickname: '原发言人' }, message: [{ type: 'text', text: '小团' }] });
    const first = h.instance.chat(e);
    await began.promise;
    await h.instance.accept(h.event('我说引用里那个', { user_id: OWNER, group_id: GROUP, bot: e.bot }));
    finish.resolve(message('被打断的旧回复')); await first;
    await clock.advance(8000);
    assert.equal(h.calls.length, 2);
    assert.match(bodyOf(h.calls[1]), /小团/);
    assert.match(bodyOf(h.calls[1]), /userid=77777 团子/);
    assert.match(h.calls[1].messages[0].content, /【本轮成员称呼绑定】/);
});
