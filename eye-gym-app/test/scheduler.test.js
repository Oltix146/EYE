'use strict';
// Проверки таймера перерывов: node --test
const test = require('node:test');
const assert = require('node:assert/strict');
const { BreakScheduler, AWAY_SEC } = require('../electron/scheduler');

const MIN = 60000;
function setup(opts = {}){
  const clock = { t: Date.UTC(2026, 0, 1, 9, 0, 0) };
  const s = new BreakScheduler({ now: () => clock.t, ...opts });
  // имитация работы: тики каждые 15 секунд; возвращает моменты напоминаний (в минутах от старта)
  const start = clock.t;
  const run = (minutes, input = () => ({})) => {
    const fired = [];
    const end = clock.t + minutes * MIN;
    while (clock.t < end){
      clock.t += 15000;
      if (s.tick(input(clock.t))) fired.push(Math.round((clock.t - start) / 1000) / 60);
    }
    return fired;
  };
  return { s, clock, run, start };
}

test('напоминает каждые 20 минут работы', () => {
  const { run } = setup();
  assert.deepEqual(run(61), [20, 40, 60]);
});

test('другой интервал применяется сразу и отсчитывается заново', () => {
  const { s, run } = setup();
  run(10);
  s.setInterval(30);
  assert.deepEqual(run(61), [40, 70]);
});

test('перерыв или гимнастика начинают отсчёт заново', () => {
  const { s, run } = setup();
  run(15);
  s.breakDone();
  assert.deepEqual(run(30), [35]);
});

test('если человек отошёл больше чем на 5 минут, отсчёт начинается после возвращения', () => {
  const { clock, run, start } = setup();
  const awayFrom = start + 12 * MIN, awayTo = start + 25 * MIN;
  const fired = run(60, t => ({ idleSec: t >= awayFrom && t < awayTo ? (t - awayFrom) / 1000 + 60 : 5 }));
  // ушёл на 12-й минуте (простой > 5 мин засчитан к ~16-й), вернулся на 25-й → следующие 20 минут считаются с 25-й
  assert.deepEqual(fired, [45]);
  assert.ok(clock.t > awayTo);
});

test('короткий простой (меньше 5 минут) не сбивает таймер', () => {
  const { run, start } = setup();
  const fired = run(21, t => ({ idleSec: t > start + 5 * MIN && t < start + 8 * MIN ? AWAY_SEC - 30 : 0 }));
  assert.deepEqual(fired, [20]);
});

test('блокировка экрана и сон считаются отдыхом', () => {
  const { s, clock, run } = setup();
  run(18);
  s.markAway();
  clock.t += 40 * MIN;             // компьютер спал
  s.markBack();
  assert.deepEqual(run(21), [78.25]);   // вернулся на 58-й минуте → следующий перерыв через 20 минут
});

test('пропуск тиков (сон без события resume) тоже сбрасывает отсчёт', () => {
  const { s, clock, run } = setup();
  run(18);
  clock.t += 30 * MIN;
  assert.equal(s.tick({}), false);
  const fired = run(21);
  assert.equal(fired.length, 1);
  assert.ok(Math.abs(fired[0] - 68) < 0.3, String(fired));
});

test('во время упражнения напоминание откладывается, но не дольше 10 минут', () => {
  const { s, run } = setup();
  run(19);
  s.setBusy(true);
  const during = run(5);
  assert.deepEqual(during, []);
  s.setBusy(false);
  const after = run(2);
  assert.equal(after.length, 1);
  assert.ok(after[0] >= 24 && after[0] <= 25, String(after));

  const b = setup();
  b.run(19);
  b.s.setBusy(true);                // «забыли» окно посреди упражнения
  const fired = b.run(15);
  assert.equal(fired.length, 1);
  assert.ok(fired[0] >= 29 && fired[0] <= 30.5, String(fired));
});

test('выключенные напоминания и пауза', () => {
  const { s, run } = setup();
  s.setEnabled(false);
  assert.deepEqual(run(45), []);
  assert.equal(s.nextAt, null);
  s.setEnabled(true);
  s.pause(60 * MIN);
  assert.equal(s.isPaused(), true);
  assert.deepEqual(run(61), []);    // час паузы, затем отсчёт заново с 105-й минуты
  assert.deepEqual(run(20), [125]);
});
