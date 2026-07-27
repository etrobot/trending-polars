/**
 * A 股节假日数据（仅含非周末的休市日）。
 * 周六、周日无论是否为调休补班日，A 股一律休市，故只需记录落在
 * 周一至周五的法定节假日及调休放假日期。
 *
 * 数据来源：沪深北交易所每年发布的休市安排公告。
 * 覆盖范围：当前年份（2026）及过去 3 年（2023–2025）。
 */

// prettier-ignore
const HOLIDAYS: readonly string[] = [
  // ── 2023 ──────────────────────────────────────────────
  '20230102',   // 元旦（1/1 周日，补休周一）
  '20230123',   // 春节
  '20230124',   //
  '20230125',   //
  '20230126',   //
  '20230127',   //
  '20230405',   // 清明节
  '20230501',   // 劳动节
  '20230502',   //
  '20230503',   //
  '20230622',   // 端午节
  '20230623',   //
  '20230929',   // 中秋+国庆
  '20231002',   //
  '20231003',   //
  '20231004',   //
  '20231005',   //
  '20231006',   //

  // ── 2024 ──────────────────────────────────────────────
  '20240101',   // 元旦（12/30 Sat、12/31 Sun 周末）
  '20240209',   // 春节（除夕）
  '20240212',   //
  '20240213',   //
  '20240214',   //
  '20240215',   //
  '20240216',   //
  '20240404',   // 清明节
  '20240405',   //
  '20240501',   // 劳动节
  '20240502',   //
  '20240503',   //
  '20240610',   // 端午节（6/8 Sat、6/9 Sun 周末）
  '20240916',   // 中秋节
  '20240917',   //
  '20241001',   // 国庆节
  '20241002',   //
  '20241003',   //
  '20241004',   //
  '20241007',   //

  // ── 2025 ──────────────────────────────────────────────
  '20250101',   // 元旦
  '20250128',   // 春节
  '20250129',   //
  '20250130',   //
  '20250131',   //
  '20250203',   //
  '20250204',   //
  '20250404',   // 清明节（4/5 Sat、4/6 Sun 周末）
  '20250501',   // 劳动节
  '20250502',   //
  '20250505',   // （5/3 Sat、5/4 Sun 周末）
  '20250602',   // 端午节（5/31 Sat、6/1 Sun 周末）
  '20251001',   // 国庆+中秋
  '20251002',   //
  '20251003',   //
  '20251006',   // （10/4 Sat、10/5 Sun 周末）
  '20251007',   //
  '20251008',   //

  // ── 2026 ──────────────────────────────────────────────
  '20260101',   // 元旦
  '20260102',   // （1/3 Sat 周末）
  '20260216',   // 春节
  '20260217',   //
  '20260218',   //
  '20260219',   //
  '20260220',   //
  '20260223',   // （2/14 Sat、2/15 Sun、2/21 Sat、2/22 Sun 周末）
  '20260406',   // 清明节（4/4 Sat、4/5 Sun 周末）
  '20260501',   // 劳动节
  '20260504',   // （5/2 Sat、5/3 Sun 周末）
  '20260505',   //
  '20260619',   // 端午节（6/20 Sat、6/21 Sun 周末）
  '20260925',   // 中秋节（9/26 Sat、9/27 Sun 周末）
  '20261001',   // 国庆节
  '20261002',   //
  '20261005',   // （10/3 Sat、10/4 Sun 周末）
  '20261006',   //
  '20261007',   //
];

const HOLIDAY_SET = new Set(HOLIDAYS);

/**
 * 判断某日（YYYYMMDD）是否为非周末的法定节假日/调休休市日。
 */
export function isHoliday(compactDate: string): boolean {
  return HOLIDAY_SET.has(compactDate);
}

/**
 * 生成从 startDate 到 endDate（含）的完整交易日序列。
 * 逻辑：取所有周一至周五，排除 HOLIDAYS 中的日期。
 *
 * @param startDate 起始日期，YYYYMMDD 格式
 * @param endDate   结束日期，YYYYMMDD 格式
 */
export function buildTradingCalendar(startDate: string, endDate: string): string[] {
  const start = new Date(
    `${startDate.slice(0, 4)}-${startDate.slice(4, 6)}-${startDate.slice(6, 8)}T12:00:00+08:00`,
  );
  const end = new Date(
    `${endDate.slice(0, 4)}-${endDate.slice(4, 6)}-${endDate.slice(6, 8)}T12:00:00+08:00`,
  );
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start > end) return [];

  const days: string[] = [];
  const cursor = new Date(start);
  while (cursor <= end) {
    const year = cursor.getFullYear();
    const month = String(cursor.getMonth() + 1).padStart(2, '0');
    const day = String(cursor.getDate()).padStart(2, '0');
    const compact = `${year}${month}${day}`;
    const weekday = cursor.getUTCDay();
    if (weekday !== 0 && weekday !== 6 && !HOLIDAY_SET.has(compact)) {
      days.push(compact);
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return days;
}

/**
 * 获取当前已知的全部节假日列表（YYYYMMDD），用于调试或外部查询。
 */
export function getKnownHolidays(): readonly string[] {
  return HOLIDAYS;
}