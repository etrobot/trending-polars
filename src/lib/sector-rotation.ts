import type { SectorRotationSector } from '../types';

/** 上涨走势组用暖色（红/橙/琥珀），下跌走势组用冷色（蓝/青/靛）。 */
export const WARM_CLUSTER_COLORS = ['#cd4239', '#d0762f', '#c2992a', '#b65a2f', '#a86b2f', '#d27f6a'];
export const COOL_CLUSTER_COLORS = ['#3b6ea8', '#2c8c8f', '#5a6ab0', '#1f7a8c', '#4c6b8a', '#6b7fa3'];

export interface ClusteredSector {
  sector: SectorRotationSector;
  cluster: number;
  color: string;
  /** 同组板块越多，线条越透明（透明度越高），避免几十条线叠在一起看不清。 */
  opacity: number;
}

function dailyReturns(series: Array<number | null>): Array<number | null> {
  const returns = new Array<number | null>(series.length).fill(null);
  for (let i = 1; i < series.length; i += 1) {
    const previous = series[i - 1];
    const current = series[i];
    if (previous == null || current == null || previous <= -100) continue;
    returns[i] = (current + 100) / (previous + 100) - 1;
  }
  return returns;
}

/** 两条曲线共同有效交易日的日收益 Pearson 相关系数；重叠不足 5 天返回 null。 */
export function seriesCorrelation(left: Array<number | null>, right: Array<number | null>): number | null {
  const pairs: Array<[number, number]> = [];
  for (let i = 0; i < Math.min(left.length, right.length); i += 1) {
    const a = left[i];
    const b = right[i];
    if (a == null || b == null) continue;
    pairs.push([a, b]);
  }
  if (pairs.length < 6) return null;
  const leftReturns = dailyReturns(pairs.map(([a]) => a));
  const rightReturns = dailyReturns(pairs.map(([, b]) => b));
  const valid = leftReturns
    .map((value, index) => [value, rightReturns[index]] as const)
    .filter((item): item is readonly [number, number] => item[0] != null && item[1] != null);
  if (valid.length < 5) return null;
  const meanLeft = valid.reduce((sum, [a]) => sum + a, 0) / valid.length;
  const meanRight = valid.reduce((sum, [, b]) => sum + b, 0) / valid.length;
  let covariance = 0;
  let varianceLeft = 0;
  let varianceRight = 0;
  for (const [a, b] of valid) {
    const da = a - meanLeft;
    const db = b - meanRight;
    covariance += da * db;
    varianceLeft += da * da;
    varianceRight += db * db;
  }
  if (varianceLeft <= 0 || varianceRight <= 0) return null;
  return covariance / Math.sqrt(varianceLeft * varianceRight);
}

/**
 * 把每条曲线转换成「相对强弱」曲线：日收益减去当日所有板块的平均日收益，再逐日累加。
 * 这样剔除掉「全市场一起涨跌」的共同因素，剩下的才是各板块自己的相对走势，聚类才分得开。
 */
export function relativeStrengthSeries(all: Array<Array<number | null>>): Array<Array<number | null>> {
  const returns = all.map((series) => series.map((value, index) => {
    const previous = series[index - 1];
    if (index === 0 || value == null || previous == null || previous <= -100) return null;
    return (value + 100) / (previous + 100) - 1;
  }));
  return all.map((_, sectorIndex) => {
    let cumulative = 0;
    return returns[sectorIndex].map((value, index) => {
      if (value == null) return null;
      const peers = returns.map((row) => row[index]).filter((item): item is number => item != null);
      if (peers.length < 3) return null;
      const mean = peers.reduce((sum, item) => sum + item, 0) / peers.length;
      cumulative += (value - mean) * 100;
      return cumulative;
    });
  });
}

/** 组间平均相关性低于该值即停止合并：数值越高，最终组数越少。 */
export const MERGE_SIMILARITY = 0.72;
/** 少于该成员数的组会被并入最相似的大组，避免出现单板块碎片组。 */
export const MIN_CLUSTER_SIZE = 3;
/** 硬上限：配色只有 6 种色板，极端数据下仍强制收敛。 */
export const MAX_SECTOR_CLUSTERS = 8;

/**
 * 按走势相似度给板块分组（层次聚类，组数由数据决定）。
 *   1. 初始每个板块一组，反复合并「组间平均相关性最高」的两组，直到最高相关性低于阈值；
 *   2. 小于 MIN_CLUSTER_SIZE 的碎片组并入与它最相似的大组；
 *   3. 组数超过硬上限时继续合并最相似的两组。
 * 只比较形态（日收益相关性），不比较涨幅大小；同组曲线共用一种颜色。
 */
export function clusterSectors(sectors: SectorRotationSector[], maxGroups = MAX_SECTOR_CLUSTERS): ClusteredSector[] {
  const count = sectors.length;
  if (count === 0) return [];
  const limit = Math.max(1, Math.min(maxGroups, count));
  // 聚类看「相对强弱」而不是原始涨跌：原始曲线几乎都被大盘带着走。
  const relative = relativeStrengthSeries(sectors.map((sector) => sector.series));
  const cache = new Map<string, number>();
  const correlation = (left: number, right: number): number => {
    if (left === right) return 1;
    const key = left < right ? `${left}:${right}` : `${right}:${left}`;
    const cached = cache.get(key);
    if (cached != null) return cached;
    const value = seriesCorrelation(relative[left], relative[right]) ?? 0;
    cache.set(key, value);
    return value;
  };
  /** 两组之间的平均联动相关性。 */
  const averageSimilarity = (left: number[], right: number[]): number => {
    let sum = 0;
    for (const i of left) for (const j of right) sum += correlation(i, j);
    return sum / (left.length * right.length);
  };

  let clusters: number[][] = sectors.map((_, index) => [index]);
  while (clusters.length > 1) {
    let bestLeft = 0;
    let bestRight = 1;
    let best = -Infinity;
    for (let i = 0; i < clusters.length; i += 1) {
      for (let j = i + 1; j < clusters.length; j += 1) {
        const score = averageSimilarity(clusters[i], clusters[j]);
        if (score > best) {
          best = score;
          bestLeft = i;
          bestRight = j;
        }
      }
    }
    if (best < MERGE_SIMILARITY && clusters.length <= limit) break;
    clusters[bestLeft] = [...clusters[bestLeft], ...clusters[bestRight]];
    clusters.splice(bestRight, 1);
  }

  // 碎片组（例如只有白酒一个板块）并入与它最相似的大组，避免图例被零碎小组塞满。
  while (clusters.length > 1) {
    const small = clusters.findIndex((cluster) => cluster.length < MIN_CLUSTER_SIZE);
    if (small < 0) break;
    let target = -1;
    let best = -Infinity;
    clusters.forEach((cluster, index) => {
      if (index === small) return;
      const score = averageSimilarity(clusters[small], cluster);
      if (score > best) {
        best = score;
        target = index;
      }
    });
    clusters[target] = [...clusters[target], ...clusters[small]];
    clusters.splice(small, 1);
  }

  // 成员多的组排前面，组号 01 即最大组。
  clusters.sort((left, right) => right.length - left.length);

  const groupSizes = new Map<number, number>();
  const groupChangeSums = new Map<number, number>();
  clusters.forEach((cluster, group) => {
    groupSizes.set(group, cluster.length);
    groupChangeSums.set(group, cluster.reduce((sum, index) => sum + sectors[index].changePct, 0));
  });
  const maxSize = Math.max(1, ...groupSizes.values());
  // 组内板块越多越透明：1 个板块几乎不透明，最大组降到最低可见度。
  const opacityFor = (size: number) => Math.max(0.25, 0.95 - (size / maxSize) * 0.65);

  const warmGroups: number[] = [];
  const coolGroups: number[] = [];
  for (const group of [...groupSizes.keys()].sort((a, b) => a - b)) {
    const average = (groupChangeSums.get(group) ?? 0) / (groupSizes.get(group) ?? 1);
    (average > 0 ? warmGroups : coolGroups).push(group);
  }
  const groupColors = new Map<number, string>();
  warmGroups.forEach((group, index) => groupColors.set(group, WARM_CLUSTER_COLORS[index % WARM_CLUSTER_COLORS.length]));
  coolGroups.forEach((group, index) => groupColors.set(group, COOL_CLUSTER_COLORS[index % COOL_CLUSTER_COLORS.length]));

  return clusters.flatMap((cluster, group) => cluster.map((index) => ({
    sector: sectors[index],
    cluster: group,
    color: groupColors.get(group) ?? COOL_CLUSTER_COLORS[0],
    opacity: opacityFor(groupSizes.get(group) ?? 1),
  })));
}
