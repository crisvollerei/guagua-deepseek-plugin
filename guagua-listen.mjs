// 明确入口后的限时接话。准入期限与已经接收的轮次分别管理。
export class ConversationListening {
    constructor({ now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, ttl = 60000,
        current = () => true, judge, reply,
        capture = (state, message, options) => state.root.handler?.captureListening?.(state, message, options),
        remember = (state, messages, options) => state.root.handler?.rememberListening?.(state, messages, options),
        onError = () => {} } = {}) {
        Object.assign(this, { now, setTimer, clearTimer, ttl, current, judge, reply, capture, remember, onError });
        this.sessions = new Map();
        this.focus = new Map();
        this.counter = 0;
        this.turnCounter = 0;
        this.active = true;
    }

    valid(state) { return Boolean(state) && this.active && this.sessions.get(state.id) === state && this.current(state); }
    admitting(state) { return this.valid(state) && state.participants.size > 0 && this.now() < state.expiresAt; }

    byUser(scope, userId) {
        const state = this.focus.get(this.focusKey(scope, userId));
        return state?.participants.has(String(userId)) && this.admitting(state) ? state : null;
    }

    focusKey(scope, userId) { return JSON.stringify([scope, String(userId)]); }
    focusOn(state, userId) { this.focus.set(this.focusKey(state.scope, userId), state); }
    release(input) {
        input?.reference?.release?.();
        input?.windowRelease?.();
    }

    boundedImages(images, state) {
        const sources = new Set();
        for (const other of this.sessions.values()) if (other !== state && !other.imageWindow) {
            for (const image of other.images || []) if (image.src) sources.add(image.src);
        }
        let total = [...sources].reduce((sum, src) => sum + Buffer.byteLength(src, 'utf8'), 0), own = 0;
        const ownSources = new Set();
        return (Array.isArray(images) ? images : []).slice(0, 8).map(image => {
            const item = {};
            for (const key of ['speakerId', 'speakerName', 'messageId', 'origin', 'label', 'unavailableReason']) {
                if (typeof image?.[key] === 'string') item[key] = image[key].slice(0, 500);
            }
            const src = typeof image?.src === 'string' ? image.src : '';
            if (src) {
                const bytes = Buffer.byteLength(src, 'utf8'), ownAdded = ownSources.has(src) ? 0 : bytes, totalAdded = sources.has(src) ? 0 : bytes;
                if (own + ownAdded <= 12 * 1024 * 1024 && total + totalAdded <= 32 * 1024 * 1024) {
                    item.src = src;
                    own += ownAdded; total += totalAdded;
                    ownSources.add(src); sources.add(src);
                } else item.unavailableReason = '图片来源缓存容量限制';
            }
            if (!item.src) {
                item.unavailable = true;
                item.unavailableReason ||= '未保留可读取的图片来源';
            }
            return item;
        });
    }

    byWindow(scope, window) {
        if (!window) return null;
        return [...this.sessions.values()].find(state => state.scope === scope && state.window === window && this.admitting(state)) || null;
    }

    open(input) {
        if (!this.active || (input.state && input.state.scope !== input.scope)) return null;
        let state = input.state && this.valid(input.state) ? input.state : [...this.sessions.values()].find(item =>
            input.window && item.scope === input.scope && item.window === input.window && this.valid(item));
        if (!state && input.state && this.byUser(input.scope, input.userId)) return null;
        if (!state) {
            state = { id: `conversation-${++this.counter}`, startedAt: this.now(), scope: input.scope, token: input.token,
                root: input, participants: new Set(), messages: [], recent: [], history: [], actions: [], seen: new Set(), remembered: new Set(), memorySources: new Map(),
                seq: 0, version: 0, handledSeq: 0, evaluatedVersion: -1, busy: false, window: null, entry: input.entry || 'command' };
            if (!this.current(state)) return null;
            this.sessions.set(state.id, state);
            if (this.sessions.size > 128) this.stop(this.sessions.values().next().value);
        }
        state.participants.add(String(input.userId));
        this.focusOn(state, input.userId);
        if (input.window) state.window = input.window;
        if (input.history) state.history = input.history;
        if (Array.isArray(input.images)) {
            state.images = input.images;
            state.imageWindow = input.window || null;
        }
        state.expiresAt = this.now() + this.ttl;
        this.sessions.delete(state.id);
        this.sessions.set(state.id, state);
        if (!state.busy && !state.timer && !state.turn) this.park(state);
        return state;
    }

    // 实际回执可以在生成被新消息取消后提交，但不会重新加入已退出者或重开旧话题。
    recordReply(state, { window, history, userId, images = [] }) {
        if (!this.valid(state)) return null;
        if (window) {
            state.window = window;
            // 发送尚未回执时也可能已收到补充；窗口建立后补上这些消息的保护。
            for (const message of state.messages) {
                if (!message.reference && !message.windowRelease) message.windowRelease = window.retain?.();
            }
        }
        state.history = history;
        state.images = window?.images || this.boundedImages(images, state);
        state.imageWindow = window || null;
        if (state.participants.has(String(userId))) state.expiresAt = this.now() + this.ttl;
        if (!state.busy && !state.timer && !state.turn) this.park(state);
        return state;
    }

    append(state, input) {
        if (input.eventId) state.seen.add(String(input.eventId));
        const message = { ...input, id: `${state.id}:m${++state.seq}`, seq: state.seq,
            windowRelease: input.reference ? undefined : state.window?.retain?.() };
        state.messages.push(message);
        state.recent = [...state.recent, message].slice(-12);
        state.version++;
        // 先在本地保存已准入的原话；接话判断不再决定这些话有没有机会被整理。
        try { this.capture(state, message, { context: state.recent }); }
        catch (error) { this.onError(error); }
        return message;
    }

    beginTurn(state, input, { collected = false, through = state?.seq, participantIds = [input.userId] } = {}) {
        if (!this.valid(state)) return null;
        if (state.turn) state.turn.cancelled = true;
        const turn = { id: ++this.turnCounter, input, through, collected, cancelled: false, promoted: false,
            participants: new Set(participantIds.map(String)) };
        state.turn = turn;
        this.clearTimer(state.idleTimer);
        state.idleTimer = null;
        return turn;
    }

    currentTurn(state, turn) {
        return this.valid(state) && state.turn === turn && !turn.cancelled &&
            [...turn.participants].every(id => state.participants.has(id));
    }

    finishTurn(state, turn) {
        if (!turn) return;
        if (state?.turn === turn) state.turn = null;
        if (this.valid(state) && !state.busy && !state.timer) {
            if (state.messages.length) this.restart(state);
            else this.park(state);
        }
    }

    receive(input) {
        if (!this.active) return null;
        let state = input.reference ? this.byWindow(input.scope, input.reference.window) : this.byUser(input.scope, input.userId);
        if (!state && !input.start) return null;
        if (!state) state = this.open(input);
        if (!state || !this.admitting(state)) return null;
        if (input.eventId && state.seen.has(String(input.eventId))) {
            // 重复投递可能携带另一个租约，但不能提前释放原来仍待处理的引用。
            if (!state.messages.some(message => message.reference === input.reference) && state.turn?.input.reference !== input.reference) this.release(input);
            return state;
        }
        state.participants.add(String(input.userId));
        if (input.reference) {
            this.focusOn(state, input.userId);
            state.expiresAt = this.now() + this.ttl;
        }
        if (state.turn && !state.turn.cancelled) {
            const turn = state.turn;
            turn.cancelled = true;
            // 直接回答被打断时，原问题也进入重判，不能只剩下后来的补充。
            if (!turn.collected && !turn.promoted && state.participants.has(String(turn.input.userId))) {
                this.append(state, turn.input);
                turn.promoted = true;
            }
        }
        this.append(state, input);
        this.clearTimer(state.idleTimer);
        state.idleTimer = null;
        if (!state.timer && !state.busy) this.restart(state);
        return state;
    }

    timer(state, delay, task) {
        const timer = this.setTimer(() => {
            if (!this.valid(state)) { this.stop(state); return; }
            return Promise.resolve().then(task).catch(error => {
                this.stop(state);
                this.onError(error);
            });
        }, delay);
        timer?.unref?.();
        return timer;
    }

    park(state) {
        if (!this.valid(state)) return;
        this.clearTimer(state.timer);
        state.timer = null;
        this.clearTimer(state.idleTimer);
        state.idleTimer = this.timer(state, Math.max(0, state.expiresAt - this.now()), () => {
            state.idleTimer = null;
            if (!state.busy && !state.turn && !state.timer) this.stop(state);
        });
    }

    restart(state) {
        if (!this.valid(state)) return;
        this.clearTimer(state.timer);
        this.clearTimer(state.idleTimer);
        state.idleTimer = null;
        state.stage = 0;
        state.stageSeq = state.seq;
        state.timer = this.timer(state, 8000, () => this.boundary(state));
    }

    boundary(state) {
        state.timer = null;
        if (!this.valid(state)) return;
        if (state.seq > state.stageSeq && state.stage < 2) {
            state.stage++;
            state.stageSeq = state.seq;
            state.timer = this.timer(state, state.stage === 1 ? 4000 : 2000, () => this.boundary(state));
            return;
        }
        return this.evaluate(state);
    }

    async evaluate(state) {
        if (!this.valid(state) || state.busy) return;
        const batch = state.messages.filter(message => message.seq > state.handledSeq && state.participants.has(String(message.userId)));
        if (!batch.length || state.version === state.evaluatedVersion) { this.park(state); return; }
        const through = state.seq, version = state.version;
        state.evaluatedVersion = version;
        state.busy = true;
        try {
            const candidates = [...new Map([...state.recent, ...batch].filter(message => state.participants.has(String(message.userId))).map(message => [message.id, message])).values()];
            const fresh = batch.filter(message => !state.remembered.has(message.id));
            if (fresh.length) {
                const sources = await this.remember(state, fresh, { context: candidates });
                if (!this.valid(state)) return;
                if (sources !== false && !(Array.isArray(sources) && sources.some(source => source.captureError))) for (const message of fresh) state.remembered.add(message.id);
                if (Array.isArray(sources)) for (const message of fresh) state.memorySources.set(message.id,
                    sources.filter(source => !source.originIds || source.originIds.includes(message.id)));
                if (state.version !== version) { this.restart(state); return; }
            }
            const result = await this.judge(state, batch);
            if (!this.valid(state)) return;
            if (!['wait', 'silent', 'reply', 'end'].includes(result?.action)) throw Error('接话判断结果无效');
            // 期限内补充仍可取消旧快照；期限后不再准入新消息，最后的快照必能收尾。
            if (state.version !== version) { this.restart(state); return; }
            // 新补充可能使判断重跑，但已整理消息的回执关联仍属于本批原请求。
            result.memorySources = batch.flatMap(message => state.memorySources.get(message.id) || []);
            if (result.action === 'end') {
                for (const id of result.targets || [batch.at(-1).userId]) this.leave(state, id);
                if (this.valid(state)) {
                    if (state.messages.length) this.restart(state);
                    else this.park(state);
                }
                return;
            }
            if (result.action === 'wait') {
                state.actions = [...state.actions, { action: result.action, through }].slice(-5);
                this.park(state);
                return;
            }
            if (result.action === 'reply') {
                const selected = new Set(result.ids || []);
                if (!selected.size || [...selected].some(id => !batch.some(message => message.id === id))) throw Error('接话判断选择了无效消息');
                const outcome = await this.reply(state, batch.filter(message => selected.has(message.id)), { ...result, through });
                if (!this.valid(state)) return;
                if (outcome?.cancelled || state.version !== version) { this.restart(state); return; }
            }
            state.actions = [...state.actions, { action: result.action, through }].slice(-5);
            state.handledSeq = through;
            for (const message of state.messages) if (message.seq <= through) {
                this.release(message);
                state.memorySources.delete(message.id);
            }
            state.messages = state.messages.filter(message => message.seq > through);
            if (state.messages.length) this.restart(state);
            else this.park(state);
        } finally { state.busy = false; }
    }

    leave(state, userId) {
        const id = String(userId);
        if (!this.valid(state) || !state.participants.delete(id)) return;
        state.version++;
        const key = this.focusKey(state.scope, id);
        if (this.focus.get(key) === state) this.focus.delete(key);
        for (const message of state.messages) if (String(message.userId) === id) {
            this.release(message);
            state.memorySources.delete(message.id);
        }
        state.messages = state.messages.filter(message => String(message.userId) !== id);
        if (state.turn?.participants.has(id)) {
            state.turn.cancelled = true;
            if (String(state.turn.input.userId) === id) this.release(state.turn.input);
        }
        if (!state.participants.size) { this.stop(state); return; }
        if (!state.busy && !state.turn && !state.timer) {
            if (state.messages.length) this.restart(state);
            else this.park(state);
        }
    }

    stop(state) {
        if (!state) return;
        if (state.turn) state.turn.cancelled = true;
        this.release(state.root);
        this.release(state.turn?.input);
        for (const message of state.messages) this.release(message);
        for (const id of state.participants) {
            const key = this.focusKey(state.scope, id);
            if (this.focus.get(key) === state) this.focus.delete(key);
        }
        this.clearTimer(state.timer);
        this.clearTimer(state.idleTimer);
        this.sessions.delete(state.id);
    }

    invalidate(scope) {
        for (const state of this.sessions.values()) if (state.scope === scope) this.stop(state);
    }

    stopForUser(scope, userId) {
        for (const state of this.sessions.values()) if (state.scope === scope && state.participants.has(String(userId))) this.leave(state, userId);
    }

    dispose() {
        this.active = false;
        for (const state of this.sessions.values()) this.stop(state);
        this.focus.clear();
    }
}
