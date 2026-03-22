import type { ExecuteJobResult, ValidationResult } from "../../../runtime/offeringTypes.js";

const BASE_RPC_URLS = [
  "https://mainnet.base.org",
  "https://base-rpc.publicnode.com",
  "https://base.llamarpc.com",
];

function reject(reason: string): ValidationResult {
  return { valid: false, reason };
}

function isEvmAddress(value: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(value);
}

async function ethCall(to: string, data: string): Promise<string> {
  let lastError: string | null = null;

  for (const rpcUrl of BASE_RPC_URLS) {
    try {
      const res = await fetch(rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: Date.now(),
          method: "eth_call",
          params: [{ to, data }, "latest"],
        }),
      });

      if (!res.ok) {
        lastError = `${rpcUrl} HTTP ${res.status}`;
        continue;
      }

      const json = await res.json();
      if (json?.error) {
        lastError = `${rpcUrl} RPC error: ${json.error?.message ?? "unknown"}`;
        continue;
      }

      return String(json?.result ?? "0x");
    } catch (error: any) {
      lastError = `${rpcUrl} network error: ${error?.message ?? "unknown"}`;
    }
  }

  throw new Error(`Base RPC call failed on all endpoints (${lastError ?? "unknown"})`);
}

function decodeBytes32String(hex: string): string | null {
  if (!hex || !hex.startsWith("0x") || hex.length < 66) return null;
  const data = hex.slice(2, 66);
  const text = Buffer.from(data, "hex")
    .toString("utf8")
    .replace(/\u0000/g, "")
    .trim();
  return text || null;
}

function decodeDynamicString(hex: string): string | null {
  if (!hex || !hex.startsWith("0x")) return null;

  // Some tokens incorrectly return bytes32 for name/symbol.
  if (hex.length === 66) return decodeBytes32String(hex);
  if (hex.length < 130) return null;

  try {
    const offset = Number(BigInt(`0x${hex.slice(2, 66)}`));
    const lengthPos = 2 + offset * 2;
    if (hex.length < lengthPos + 64) return null;

    const strLen = Number(BigInt(`0x${hex.slice(lengthPos, lengthPos + 64)}`));
    const dataStart = lengthPos + 64;
    const dataEnd = dataStart + strLen * 2;
    if (hex.length < dataEnd) return null;

    const data = hex.slice(dataStart, dataEnd);
    const text = Buffer.from(data, "hex")
      .toString("utf8")
      .replace(/\u0000/g, "")
      .trim();
    return text || null;
  } catch {
    return null;
  }
}

function decodeUint(hex: string): string | null {
  if (!hex || !hex.startsWith("0x") || hex.length < 3) return null;
  try {
    return BigInt(hex).toString(10);
  } catch {
    return null;
  }
}

async function callBaseScanV2(params: Record<string, string>): Promise<any> {
  const apiKey = process.env.ETHERSCAN_API_KEY;
  if (!apiKey) throw new Error("ETHERSCAN_API_KEY is missing in environment");

  const search = new URLSearchParams({ chainid: "8453", ...params, apikey: apiKey });
  const url = `https://api.etherscan.io/v2/api?${search.toString()}`;

  const res = await fetch(url, { method: "GET", headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`BaseScan V2 HTTP ${res.status}`);
  return res.json();
}

export function validateRequirements(request: any): ValidationResult {
  if (!request || typeof request !== "object") return reject("invalid request");

  const tokenAddress = String(request.tokenAddress ?? "").trim();
  if (!isEvmAddress(tokenAddress))
    return reject("tokenAddress must be a valid EVM address (0x + 40 hex)");

  if (request.includeSource !== undefined && typeof request.includeSource !== "boolean") {
    return reject("includeSource must be boolean");
  }

  return { valid: true };
}

export function requestPayment(): string {
  return "Accepted request for base_token_scan. Please proceed with payment of 0.01 USDC (fixed fee).";
}

export async function executeJob(request: any): Promise<ExecuteJobResult> {
  const tokenAddress = String(request.tokenAddress).trim();
  const includeSource = request.includeSource ?? true;

  try {
    const [nameHex, symbolHex, decimalsHex, supplyHex, sourceRaw] = await Promise.all([
      ethCall(tokenAddress, "0x06fdde03"), // name()
      ethCall(tokenAddress, "0x95d89b41"), // symbol()
      ethCall(tokenAddress, "0x313ce567"), // decimals()
      ethCall(tokenAddress, "0x18160ddd"), // totalSupply()
      includeSource
        ? callBaseScanV2({ module: "contract", action: "getsourcecode", address: tokenAddress })
        : Promise.resolve(null),
    ]);

    const source = Array.isArray(sourceRaw?.result) ? (sourceRaw.result[0] ?? null) : null;

    const sourceCode = typeof source?.SourceCode === "string" ? source.SourceCode.trim() : "";
    const isVerified = includeSource
      ? Boolean(sourceCode) && sourceCode !== "Contract source code not verified"
      : null;

    const warnings: string[] = [];
    if (includeSource && sourceRaw?.status === "0") {
      warnings.push(
        `BaseScan V2 source lookup returned status=0: ${sourceRaw?.message ?? "unknown"}`
      );
    }

    const deliverable = {
      chain: "base",
      tokenAddress,
      scannedAt: new Date().toISOString(),
      token: {
        name: decodeDynamicString(nameHex),
        symbol: decodeDynamicString(symbolHex),
        decimals: decodeUint(decimalsHex),
        totalSupplyRaw: decodeUint(supplyHex),
      },
      source: includeSource
        ? {
            isVerified,
            contractName: source?.ContractName ?? null,
            compilerVersion: source?.CompilerVersion ?? null,
            optimizationUsed: source?.OptimizationUsed ?? null,
            runs: source?.Runs ?? null,
            proxy: source?.Proxy ?? null,
            implementation: source?.Implementation ?? null,
          }
        : null,
      warnings,
      raw: {
        rpc: {
          name: nameHex,
          symbol: symbolHex,
          decimals: decimalsHex,
          totalSupply: supplyHex,
        },
        sourceStatus: includeSource ? (sourceRaw?.status ?? null) : null,
        sourceMessage: includeSource ? (sourceRaw?.message ?? null) : null,
      },
    };

    return { deliverable: { type: "base_token_scan", value: deliverable } };
  } catch (error: any) {
    return {
      deliverable: `ERROR: base_token_scan failed (${error?.message ?? "unknown"})`,
    };
  }
}
