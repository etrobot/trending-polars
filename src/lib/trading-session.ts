const SESSION_START_MINUTE = 9 * 60 + 25;

export function shanghaiClock(date: Date): { date: string; minute: number; weekday: number; timestamp: string } {
  const formatter = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  const compact = `${parts.year}${parts.month}${parts.day}`;
  const minute = Number(parts.hour) * 60 + Number(parts.minute);
  const weekday = new Date(`${parts.year}-${parts.month}-${parts.day}T12:00:00+08:00`).getUTCDay();
  return {
    date: compact,
    minute,
    weekday,
    timestamp: `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`,
  };
}

/** 前端即时校验：周末与 09:25 前（节假日由服务端 trading_session 判定）。 */
export function clientImmediateAutoRejection(date = new Date()): string | null {
  const clock = shanghaiClock(date);
  if (clock.weekday === 0 || clock.weekday === 6) {
    return '当前不是交易日（周末），无法立即执行';
  }
  if (clock.minute < SESSION_START_MINUTE) {
    return '当前不在交易时段（09:25 后方可执行）';
  }
  return null;
}
