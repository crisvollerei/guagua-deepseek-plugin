import * as fs from 'node:fs';
import path from 'node:path';

const id = value => value == null ? '' : String(value);
const keyOf = (botId, groupId) => `${id(botId)}:group:${id(groupId)}`;
const botIdOf = e => id(e.self_id || e.bot?.uin || e.bot?.self_id || 'default');
const entriesOf = value => Array.isArray(value) ? value.map(member => [member?.user_id ?? member?.uid ?? member, member]) :
    typeof value?.entries === 'function' ? [...value.entries()] : value && typeof value === 'object' ? Object.entries(value) : null;

export class GroupRoster {
    constructor({ directory, logger = console, now = Date.now, config = () => ({}), onRevoke = () => {} }) {
        this.file = path.join(directory, 'group-members.json');
        this.logger = logger;
        this.now = now;
        this.config = config;
        this.onRevoke = onRevoke;
        this.data = { version: 1, groups: {} };
        this.fresh = new Set();
        this.witnesses = new Map();
        this.tokens = new WeakMap();
        this.events = new WeakSet();
        this.inflight = new Map();
        this.active = new Map();
        this.attempts = new Map();
        this.dirty = false;
        this.blocked = false;
        try {
            if (fs.existsSync(this.file)) {
                const data = JSON.parse(fs.readFileSync(this.file, 'utf8').replace(/^\uFEFF/, ''));
                if (data?.version !== 1 || !data.groups || Array.isArray(data.groups) ||
                    Object.values(data.groups).some(g => !g || !g.members || Array.isArray(g.members))) throw Error('成员表结构无效');
                this.data = data;
            }
        } catch (error) {
            this.blocked = true;
            this.logger.error('[呱瓜成员] 成员文件读取失败，停止覆盖原文件：', error.message);
        }
        // 持久化名单可用于保留退群状态与名字；重启后必须重新取得当前成员资格。
    }

    ttl() { return (Number(this.config().memberRefreshSeconds) || 300) * 1000; }
    group(botId, groupId) {
        const key = keyOf(botId, groupId);
        return this.data.groups[key] ||= { botId: id(botId), groupId: id(groupId), revision: 0, checkedAt: 0, members: {} };
    }

    noteMessage(e) {
        if (!e.group_id || !e.user_id || (e.post_type && e.post_type !== 'message') || this.events.has(e)) return;
        this.events.add(e);
        const botId = botIdOf(e), key = keyOf(botId, e.group_id), uid = id(e.user_id), now = this.now();
        const group = this.group(botId, e.group_id), previous = group.members[uid];
        const stamp = Number(e.time), hasTime = Number.isFinite(stamp) && stamp > 0;
        const sentAt = hasTime ? (stamp < 1e12 ? stamp * 1000 : stamp) : now;
        if (now - sentAt >= this.ttl() || sentAt > now + 60000) return;
        if (previous?.status === 'left' && (!hasTime || sentAt <= Math.max(previous.changedAt, previous.eventAt || 0))) return;
        if (previous?.status !== 'present') group.revision++;
        group.members[uid] = { ...previous, status: 'present', changedAt: now,
            card: String(e.sender?.card || previous?.card || ''), nickname: String(e.sender?.nickname || previous?.nickname || '') };
        group.botPresent = true;
        this.witnesses.set(`${key}:${uid}`, Math.min(now, sentAt));
        this.active.set(key, { e, at: now });
        this.dirty = true;
    }

    handleNotice(e) {
        if (!e.group_id || !e.user_id || e.post_type !== 'notice') return false;
        const type = e.notice_type === 'group_increase' ? 'increase' : e.notice_type === 'group_decrease' ? 'decrease' :
            e.notice_type === 'group' ? e.sub_type : '';
        if (!['increase', 'decrease'].includes(type)) return false;
        const botId = botIdOf(e), key = keyOf(botId, e.group_id), uid = id(e.user_id), now = this.now();
        const group = this.group(botId, e.group_id), previous = group.members[uid];
        const stamp = Number(e.time), eventAt = Number.isFinite(stamp) && stamp > 0 ? (stamp < 1e12 ? stamp * 1000 : stamp) : now;
        if (previous?.eventAt && eventAt < previous.eventAt) return false;
        if (type === 'increase' && previous?.status === 'left' && eventAt < Math.floor(previous.changedAt / 1000) * 1000) return false;
        group.revision++;
        group.members[uid] = { ...previous, status: type === 'increase' ? 'present' : 'left', changedAt: now, eventAt,
            card: String(e.member?.card || e.sender?.card || previous?.card || ''),
            nickname: String(e.member?.nickname || e.nickname || previous?.nickname || '') };
        if (type === 'increase') this.witnesses.set(`${key}:${uid}`, Math.min(now, eventAt));
        else this.witnesses.delete(`${key}:${uid}`);
        if (uid === botId) {
            group.botPresent = type === 'increase';
            this.fresh.delete(key);
            this.attempts.delete(key);
            if (type === 'decrease') {
                for (const [memberId, member] of Object.entries(group.members)) {
                    member.status = 'left';
                    member.changedAt = now;
                    this.witnesses.delete(`${key}:${memberId}`);
                }
                this.active.delete(key);
            }
        }
        if (group.botPresent !== false) this.active.set(key, { e, at: now });
        this.dirty = true;
        this.flush();
        return true;
    }

    ids(botId, groupId) {
        const key = keyOf(botId, groupId), group = this.data.groups[key];
        if (!group || group.botPresent === false) return [];
        const complete = this.fresh.has(key) && this.now() - group.checkedAt < this.ttl();
        return Object.entries(group.members).filter(([uid, member]) => member.status === 'present' &&
            (complete || this.now() - (this.witnesses.get(`${key}:${uid}`) ?? -Infinity) < this.ttl())).map(([uid]) => uid);
    }

    context(e, userIds = []) {
        const botId = botIdOf(e), groupId = id(e.group_id), token = Object.freeze({});
        this.tokens.set(token, { botId, groupId });
        return { botId, groupId, sessionId: `${botId}:${groupId ? `group:${groupId}` : `private:${id(e.user_id)}`}`,
            userIds: [...new Set(userIds.map(id).filter(Boolean))], groupAccess: token,
            memberNames: this.names(botId, groupId) };
    }

    authorizedIds(groupId, context = {}) {
        const access = this.tokens.get(context.groupAccess);
        if (!access || access.groupId !== id(groupId) || access.botId !== id(context.botId) || id(context.groupId) !== id(groupId)) return [];
        return this.ids(access.botId, access.groupId);
    }

    names(botId, groupId) {
        const group = this.data.groups[keyOf(botId, groupId)];
        return Object.fromEntries(this.ids(botId, groupId).map(uid => [uid,
            [...new Set([group.members[uid].card, group.members[uid].nickname].filter(Boolean))]]));
    }

    async ensure(e) {
        const botId = botIdOf(e), groupId = id(e.group_id);
        if (!groupId) return;
        const key = keyOf(botId, groupId), group = this.group(botId, groupId), now = this.now();
        if (group.botPresent === false || (this.fresh.has(key) && now - group.checkedAt < this.ttl())) return;
        if (this.inflight.has(key)) return this.inflight.get(key);
        if (now - (this.attempts.get(key) ?? -Infinity) < 30000) return;
        this.attempts.set(key, now);
        const request = this.fetch(e, group, key);
        this.inflight.set(key, request);
        try { await request; } finally { if (this.inflight.get(key) === request) this.inflight.delete(key); }
    }

    async fetch(e, group, key) {
        const revision = group.revision;
        let timer;
        try {
            let target = e.bot?.pickGroup?.(e.group_id);
            if (typeof target?.getMemberMap !== 'function' && typeof e.group?.getMemberMap === 'function') target = e.group;
            if (typeof target?.getMemberMap !== 'function') return;
            const timeout = new Promise((_, reject) => {
                timer = setTimeout(() => reject(Error('成员表读取超时')), 5000);
                timer.unref?.();
            });
            const result = await Promise.race([Promise.resolve().then(() => target.getMemberMap(true)), timeout]);
            const entries = entriesOf(result);
            if (!entries || entries.some(([uid]) => !/^\d+$/.test(id(uid)))) throw Error('适配器未返回完整成员表');
            // 等待期间入/退群：整次旧快照作废，不能覆盖通知中的最新状态。
            if (group.revision !== revision || group.botPresent === false) { this.attempts.delete(key); return; }
            const before = this.fresh.has(key) ? Object.keys(group.members).filter(uid => group.members[uid].status === 'present') : this.ids(group.botId, group.groupId);
            const now = this.now(), present = new Set(entries.map(([uid]) => id(uid)));
            for (const [uid, member] of Object.entries(group.members)) {
                if (!present.has(uid)) { member.status = 'left'; member.changedAt = now; this.witnesses.delete(`${key}:${uid}`); }
            }
            for (const [rawId, member] of entries) {
                const uid = id(rawId);
                group.members[uid] = { ...group.members[uid], status: 'present', changedAt: now,
                    card: String(member?.card || ''), nickname: String(member?.nickname || '') };
            }
            group.revision++;
            group.checkedAt = now;
            group.botPresent = true;
            this.fresh.add(key);
            this.dirty = true;
            this.flush();
            if (before.some(uid => !present.has(uid))) this.onRevoke(e);
        } catch (error) {
            this.logger.warn('[呱瓜成员] 当前名单未核实，仅保留近期真实发言/入群依据：', error.message);
        } finally { clearTimeout(timer); }
    }

    async tick() {
        this.flush();
        for (const [key, active] of this.active) {
            if (this.now() - active.at > 3600000) { this.active.delete(key); continue; }
            const group = this.data.groups[key];
            if (!this.fresh.has(key) || this.now() - group.checkedAt >= this.ttl()) { await this.ensure(active.e); break; }
        }
    }

    flush() {
        if (!this.dirty || this.blocked || !fs.existsSync(path.dirname(this.file))) return;
        try {
            const temp = `${this.file}.${process.pid}.tmp`;
            fs.writeFileSync(temp, JSON.stringify(this.data, null, 2), 'utf8');
            if (fs.existsSync(this.file)) fs.copyFileSync(this.file, `${this.file}.bak`);
            fs.renameSync(temp, this.file);
            this.dirty = false;
        } catch (error) { this.logger.error('[呱瓜成员] 保存失败，稍后重试：', error.message); }
    }
}
