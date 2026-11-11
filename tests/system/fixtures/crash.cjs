if (process.env.SYSTEM_CRASH_ENABLED !== '1') return;

const { writeSync } = require('node:fs');
const { createRequire } = require('node:module');
const Redis = createRequire('/app/package.json')('ioredis');

const stream = 'exchange:settlement:{ABC}';
const key = 'system-test:crash';
const qualifies = (event) => event.type === 'trade.executed' && Number(event.seq) >= 150;
const fields = (args) =>
  Object.fromEntries(Array.from({ length: args.length / 2 }, (_, i) => [args[i * 2], args[i * 2 + 1]]));

function crash(point, event, id) {
  writeSync(1, `system-crash ${JSON.stringify({ point, seq: event.seq, eventId: event.eventId, id })}\n`);
  process.kill(process.pid, 'SIGKILL');
}

const evaluate = Redis.prototype.eval;
Redis.prototype.eval = async function (script, keys, ...args) {
  if (keys !== 2 || !String(args[0]).startsWith('exchange:outbox:positions:') || args[1] !== stream)
    return evaluate.call(this, script, keys, ...args);
  const event = fields(args.slice(5));
  if (!qualifies(event)) return evaluate.call(this, script, keys, ...args);
  const target = await this.get(key);
  if (target?.startsWith('engine-') && target !== process.env.INSTANCE_ID) {
    // Даємо власнику забрати саме цей рядок з outbox і відтворити failover під час relay.
    throw new Error('System fault: reserved this publication for the ownership replica');
  }
  const id = await evaluate.call(this, script, keys, ...args);
  if (typeof id === 'string' && target === process.env.INSTANCE_ID && await this.getdel(key))
    crash('relay_after_xadd_before_published', event, id);
  return id;
};

const acknowledge = Redis.prototype.xack;
Redis.prototype.xack = async function (name, group, id) {
  if (name === stream && group === 'settlement' && await this.get(key) === 'settlement') {
    const [[, data]] = await this.xrange(name, id, id);
    const event = fields(data);
    if (qualifies(event) && await this.getdel(key))
      crash('settlement_after_commit_before_ack', event, id);
  }
  return acknowledge.call(this, name, group, id);
};
