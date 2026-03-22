import type { ExecuteJobResult } from "../../../runtime/offeringTypes.js";
import { spawnSync } from "node:child_process";
import path from "node:path";

function reject(reason: string) {
  return { valid: false, reason };
}

/**
 * 입력 요구사항 검증
 * - 공통: min >= 0
 * - int: max < Number.MAX_SAFE_INTEGER, min/max 정수
 * - float: max < Number.MAX_VALUE
 * - sample: items.length <= 100, count <= items.length
 */
export function validateRequirements(request: any): boolean | { valid: boolean; reason?: string } {
  if (!request || typeof request !== "object") return reject("invalid request");
  const mode = request.mode;
  if (!["int", "float", "sample"].includes(mode)) return reject("mode must be int|float|sample");

  if (mode !== "sample") {
    const min = Number(request.min ?? 0);
    const max = Number(request.max);

    if (!Number.isFinite(min) || min < 0) return reject("min must be number >= 0");
    if (!Number.isFinite(max)) return reject("max must be number");
    if (max <= min) return reject("max must be > min");

    if (mode === "int") {
      if (!Number.isInteger(min) || !Number.isInteger(max)) {
        return reject("int mode: min/max must be integers");
      }
      if (!(max < Number.MAX_SAFE_INTEGER)) {
        return reject("int mode: max must be < Number.MAX_SAFE_INTEGER");
      }
    } else if (mode === "float") {
      if (!(max < Number.MAX_VALUE)) {
        return reject("float mode: max must be < Number.MAX_VALUE");
      }
    }
  } else {
    // sample
    const { items, count } = request;
    if (!Array.isArray(items) || items.length === 0)
      return reject("sample: items must be non-empty array");
    if (items.length > 100) return reject("sample: items length must be <= 100");
    if (!Number.isInteger(count) || count <= 0)
      return reject("sample: count must be positive integer");
    if (count > items.length) return reject("sample: count cannot exceed items length");
  }

  return { valid: true };
}

/**
 * 결제 안내 메시지(선택)
 * - 고정 수수료 0.01 USDC 고지
 */
export function requestPayment(request: any): string {
  const mode = request?.mode ?? "(unknown)";
  return `Accepted request for mode=${mode}. Please proceed with payment of 0.01 USDC (fixed fee).`;
}

/**
 * 실행 로직
 * - 우리 스킬의 CLI(dist/scripts/index.js)를 서브프로세스로 호출
 * - stdout(한 줄 JSON)을 deliverable로 그대로 반환
 *
 * 환경변수:
 * - SKILL_ROOT: random-number-generator 레포의 루트 절대경로
 *   (여기에 dist/scripts/index.js가 존재해야 함)
 */
export async function executeJob(request: any): Promise<ExecuteJobResult> {
  const mode = request.mode;
  const seed = request.seed;

  // SKILL_ROOT는 random-number-generator 프로젝트 루트로 설정
  const skillRoot = process.env.SKILL_ROOT ?? process.cwd(); // 미설정 시 현재 경로 시도(권장: 환경변수로 명시)
  const cli = path.join(skillRoot, "dist", "scripts", "index.js");

  let args: string[] = [];

  if (mode === "int") {
    const min = Number(request.min ?? 0);
    const max = Number(request.max);
    args = ["random_int", "--min", String(min), "--max", String(max)];
    if (seed !== undefined) args.push("--seed", String(seed));
  } else if (mode === "float") {
    const min = Number(request.min ?? 0);
    const max = Number(request.max);
    args = ["random_float", "--min", String(min), "--max", String(max)];
    if (seed !== undefined) args.push("--seed", String(seed));
  } else {
    // sample
    const items = JSON.stringify(request.items);
    const count = Number(request.count ?? 1);
    args = ["sample", "--items", items, "--count", String(count)];
    if (seed !== undefined) args.push("--seed", String(seed));
  }

  // Node 런타임로 CLI 스크립트를 직접 실행
  const result = spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (result.status !== 0) {
    const err = (result.stderr || "").trim();
    return { deliverable: `ERROR: random-number-generator skill failed (${err || "unknown"})` };
  }

  const out = (result.stdout || "").trim();
  // 우리 스킬은 stdout에 한 줄 JSON을 내보냄 → 그대로 deliverable로 반환
  return { deliverable: out };
}
