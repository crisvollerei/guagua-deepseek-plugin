export class FakeClock {
    constructor(time = Date.now()) { this.time = time; this.nextId = 0; this.timers = new Map(); }
    now = () => this.time;
    setTimer = (task, delay) => {
        const timer = { id: ++this.nextId, at: this.time + delay, task, unref() {} };
        this.timers.set(timer.id, timer);
        return timer;
    };
    clearTimer = timer => { if (timer) this.timers.delete(timer.id); };
    async advance(ms) {
        const until = this.time + ms;
        for (;;) {
            const next = [...this.timers.values()].filter(timer => timer.at <= until).sort((a, b) => a.at - b.at || a.id - b.id)[0];
            if (!next) break;
            this.time = next.at;
            this.timers.delete(next.id);
            await next.task();
        }
        this.time = until;
    }
}
