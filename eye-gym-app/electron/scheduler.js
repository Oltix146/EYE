'use strict';
// Таймер перерывов 20-20-20. Чистая логика без Electron — её легко проверить тестами (test/scheduler.test.js).
//
// Правила:
//  • напоминание приходит через `intervalMin` минут работы за компьютером;
//  • если человек отошёл (система простаивает AWAY_SEC секунд, экран заблокирован или компьютер спал),
//    глаза уже отдохнули — после возвращения отсчёт начинается заново;
//  • пока идёт упражнение в приложении, напоминание откладывается;
//  • после перерыва или гимнастики отсчёт тоже начинается заново;
//  • пауза выключает напоминания до указанного времени.

const AWAY_SEC = 5 * 60;          // столько простоя считаем, что человек отошёл от экрана
const BUSY_MAX_MS = 10 * 60000;   // «идёт упражнение» не дольше 10 минут — вдруг окно бросили посреди упражнения
const BUSY_DELAY_MS = 60000;      // во время упражнения напоминание сдвигается на минуту вперёд
const GAP_MS = 2 * 60000;         // между тиками прошло больше — значит компьютер спал

class BreakScheduler {
  constructor({ enabled = true, intervalMin = 20, now = () => Date.now() } = {}){
    this.now = now;
    this.enabled = enabled;
    this.intervalMin = intervalMin;
    this.nextAt = null;
    this.pausedUntil = null;
    this.away = false;
    this.busyUntil = 0;
    this.lastTick = null;
    if (enabled) this.restart();
  }
  get intervalMs(){ return this.intervalMin * 60000; }

  restart(){ this.away = false; this.nextAt = this.enabled ? this.now() + this.intervalMs : null; }
  setEnabled(on){ this.enabled = !!on; this.pausedUntil = null; this.restart(); }
  setInterval(min){ this.intervalMin = Math.min(120, Math.max(1, Math.round(+min) || 20)); this.restart(); }
  pause(ms){ this.pausedUntil = this.now() + ms; this.nextAt = null; }
  resume(){ this.pausedUntil = null; this.restart(); }
  breakDone(){ this.busyUntil = 0; this.restart(); }
  setBusy(busy){ this.busyUntil = busy ? this.now() + BUSY_MAX_MS : 0; }
  markAway(){ this.away = true; }            // экран заблокирован или компьютер уходит в сон
  markBack(){ if (this.enabled && !this.isPaused()) this.restart(); else this.away = false; }
  isPaused(){ return this.pausedUntil != null && this.now() < this.pausedUntil; }

  // Вызывается каждые ~15 секунд. idleSec — сколько секунд нет ввода с клавиатуры и мыши.
  // Возвращает true, когда пора показать напоминание.
  tick({ idleSec = 0, locked = false } = {}){
    const now = this.now();
    const gap = this.lastTick != null && now - this.lastTick > GAP_MS;
    this.lastTick = now;
    if (!this.enabled) return false;
    if (this.pausedUntil != null){
      if (now < this.pausedUntil) return false;
      this.pausedUntil = null; this.restart();
    }
    if (gap){ this.restart(); return false; }
    if (locked || idleSec >= AWAY_SEC){ this.away = true; return false; }
    if (this.away){ this.restart(); return false; }
    if (this.nextAt == null) this.restart();
    if (this.busyUntil > now){
      if (this.nextAt < now + BUSY_DELAY_MS) this.nextAt = now + BUSY_DELAY_MS;
      return false;
    }
    if (now >= this.nextAt){
      this.nextAt = now + this.intervalMs;   // если перерыв пропустят, следующее напоминание — через тот же интервал
      return true;
    }
    return false;
  }
}

module.exports = { BreakScheduler, AWAY_SEC, BUSY_MAX_MS, BUSY_DELAY_MS, GAP_MS };
