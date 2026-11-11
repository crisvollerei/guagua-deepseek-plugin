import test from 'node:test';
import assert from 'node:assert/strict';
import { pluginHarness } from './plugin-harness.mjs';

const speaker = '33333', target = '44444', other = '55555';
function scenario(t, { duplicate = false, departed = false } = {}) {
    const names = { [speaker]: '叶舟', [target]: '小林', [other]: duplicate ? '小林' : '小齐' };
    const h = pluginHarness(t, { p: { users: Object.fromEntries(Object.entries(names).map(([uid, name]) => [uid, { name }])), pending: [] } });
    const memory = h.api.memory;
    memory.store.change(data => {
        // 同一个活跃群友说过猫的多件近况，足以填满默认的十二个参考名额。
        const facts = [[target, '青豆', '我家的猫叫青豆'], [other, '元宝', '我家的猫叫元宝'],
            ...Array.from({ length: 12 }, (_, i) => [speaker, '小花', '猫小花的近况' + i])];
        data.records = facts.map(([subjectId, name, content], i) => ({
            id: 'M' + String(i + 1).padStart(6, '0'), type: 'entity', status: i === 0 ? 'pending' : 'confirmed',
            subjectId, scope: { kind: 'person' }, content, entity: { name, kind: '猫', relation: '宠物' },
            createdAt: new Date(1700000000000 + i * 1000).toISOString(), source: { speakerId: subjectId }
        }));
        data.records.push({ id: 'M000015', type: 'preference', status: 'confirmed', subjectId: target, scope: { kind: 'person' },
            content: '喜欢乌龙茶', createdAt: new Date().toISOString(), source: { speakerId: target } });
        data.nextId = 16;
    });
    return async (body, extra = {}) => {
        const e = h.event('#呱瓜 ' + body, extra);
        e.bot.gml = new Map([[99999, new Map(Object.entries(names).filter(([uid]) => !departed || uid !== target)
            .map(([uid, nickname]) => [Number(uid), { nickname }]))]]);
        await h.instance.chat(e);
        return memory.lastRecall(e).records;
    };
}

test('本轮点名群友时，匹配的旧待确认资料不被说话人的多条新近况挤掉', async t => {
    const chat = scenario(t);
    const records = await chat('小林的宠物是什么');
    assert.equal(records.length, 12);
    assert.equal(records[0].subjectId, target);
    assert.equal(records[0].status, 'pending');
    assert.ok(!records.some(record => record.id === 'M000015'), '点名不应把该成员与问题无关的偏好一起提权');
});

test('引用中反复提及另一人的猫时，正文点名的对象优先', async t => {
    const chat = scenario(t);
    const records = await chat('小林的宠物是什么', { reply_id: 'old', getReply: async () => ({ user_id: other,
        message: [{ type: 'text', text: '小齐说：我家的猫叫元宝。元宝是我的猫。' }] }) });
    assert.equal(records[0].subjectId, target);
});

test('开头称呼别人后问我家的猫以本人为主，询问被点名者的猫仍优先该成员', async t => {
    const chat = scenario(t);
    assert.equal((await chat('小林，我家的猫叫什么'))[0].subjectId, speaker);
    assert.equal((await chat('我想知道小林的猫叫什么'))[0].subjectId, target);
    const mention = { type: 'at', qq: Number(target), name: '小林' };
    const atChat = text => chat(text, { message: [
        { type: 'text', text: '#呱瓜 ' }, mention, { type: 'text', text }
    ] });
    assert.equal((await atChat(' 我家的猫叫什么'))[0].subjectId, speaker);
    assert.equal((await atChat(' 你的猫叫什么'))[0].subjectId, target);
});

test('显式 @ 以当前群的账号为准，即使显示名和另一人相同', async t => {
    const chat = scenario(t, { duplicate: true });
    const records = await chat('@小林的宠物是什么', { message: [
        { type: 'text', text: '#呱瓜 ' }, { type: 'at', qq: Number(target), name: '小林' }, { type: 'text', text: '的宠物是什么' }
    ] });
    assert.equal(records[0].subjectId, target);
});

test('没点名或称呼不唯一时沿用普通相关度；点名离群的人也不显示其资料', async t => {
    for (const [options, query] of [[{}, '我的宠物是什么'], [{ duplicate: true }, '小林的宠物是什么'],
        [{ departed: true }, '小林的宠物是什么']]) {
        const records = await scenario(t, options)(query);
        assert.equal(records[0].subjectId, speaker);
        assert.ok(records.every(row => row.subjectId !== target));
    }
});
