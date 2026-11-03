/**
 * 挖掘结果落库（P4）。
 *
 * 落库目录独立于交易链路：`server/data/mining`。
 * - `runs/<runId>.json` —— MiningRun（含 commit、dataVersion、完整配置）
 * - `results/<runId>.json` —— MiningResult 列表
 * - `reports/<runId>.html` —— HTML 报告
 * - `reports/<runId>.json` —— JSON 报告
 *
 * 写入采用「临时文件 + rename」的原子写，避免进程中断留下半截文件。
 */

import { randomUUID } from 'node:crypto';
import { access, mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FrictionCalibration } from './friction.js';
import type { MiningReport, MiningResult, MiningRun } from './types.js';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_MINING_DIR = path.join(MODULE_DIR, '..', 'data', 'mining');

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, 'utf8')) as T;
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}-${randomUUID()}.tmp`;
  try {
    await writeFile(tempPath, JSON.stringify(value, null, 2), 'utf8');
    await rename(tempPath, filePath);
  } finally {
    try {
      await unlink(tempPath);
    } catch {
      // 临时文件可能已被 rename 掉。
    }
  }
}

async function writeText(filePath: string, value: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}-${randomUUID()}.tmp`;
  try {
    await writeFile(tempPath, value, 'utf8');
    await rename(tempPath, filePath);
  } finally {
    try {
      await unlink(tempPath);
    } catch {
      // 临时文件可能已被 rename 掉。
    }
  }
}

export class MiningStore {
  readonly root: string;

  constructor(root = DEFAULT_MINING_DIR) {
    this.root = root;
  }

  private runPath(runId: string): string {
    return path.join(this.root, 'runs', `${runId}.json`);
  }

  private resultPath(runId: string): string {
    return path.join(this.root, 'results', `${runId}.json`);
  }

  private reportJsonPath(runId: string): string {
    return path.join(this.root, 'reports', `${runId}.json`);
  }

  private reportHtmlPath(runId: string): string {
    return path.join(this.root, 'reports', `${runId}.html`);
  }

  async saveRun(run: MiningRun): Promise<void> {
    await writeJson(this.runPath(run.runId), run);
  }

  async getRun(runId: string): Promise<MiningRun | null> {
    const filePath = this.runPath(runId);
    if (!(await exists(filePath))) return null;
    return readJson<MiningRun>(filePath);
  }

  async listRuns(): Promise<MiningRun[]> {
    const dir = path.join(this.root, 'runs');
    let names: string[] = [];
    try {
      names = (await readdir(dir)).filter((name) => name.endsWith('.json'));
    } catch {
      return [];
    }
    const runs: MiningRun[] = [];
    for (const name of names) {
      try {
        runs.push(await readJson<MiningRun>(path.join(dir, name)));
      } catch {
        // 单个损坏文件不应让整个列表不可用。
      }
    }
    return runs.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async saveResults(runId: string, results: MiningResult[]): Promise<void> {
    await writeJson(this.resultPath(runId), results);
  }

  async getResults(runId: string): Promise<MiningResult[]> {
    const filePath = this.resultPath(runId);
    if (!(await exists(filePath))) return [];
    return readJson<MiningResult[]>(filePath);
  }

  async saveReport(report: MiningReport, html: string): Promise<void> {
    await writeJson(this.reportJsonPath(report.runId), report);
    await writeText(this.reportHtmlPath(report.runId), html);
  }

  async getReport(runId: string): Promise<MiningReport | null> {
    const filePath = this.reportJsonPath(runId);
    if (!(await exists(filePath))) return null;
    return readJson<MiningReport>(filePath);
  }

  async getReportHtml(runId: string): Promise<string | null> {
    const filePath = this.reportHtmlPath(runId);
    if (!(await exists(filePath))) return null;
    return readFile(filePath, 'utf8');
  }

  private calibrationPath(runId: string): string {
    return path.join(this.root, 'calibration', `${runId}.json`);
  }

  /**
   * 落盘实测摩擦校准数据（P5）。
   *
   * 下一轮挖掘（P3/P4）读取最新一条，用实测滑点覆盖回测默认滑点。
   */
  async saveCalibration(calibration: FrictionCalibration): Promise<void> {
    await writeJson(this.calibrationPath(calibration.runId), calibration);
  }

  async listCalibrations(): Promise<FrictionCalibration[]> {
    const dir = path.join(this.root, 'calibration');
    let names: string[] = [];
    try {
      names = (await readdir(dir)).filter((name) => name.endsWith('.json'));
    } catch {
      return [];
    }
    const calibrations: FrictionCalibration[] = [];
    for (const name of names) {
      try {
        calibrations.push(await readJson<FrictionCalibration>(path.join(dir, name)));
      } catch {
        // 单个损坏文件不应让整个列表不可用。
      }
    }
    return calibrations.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async getLatestCalibration(): Promise<FrictionCalibration | null> {
    const calibrations = await this.listCalibrations();
    return calibrations[0] ?? null;
  }
}
