import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_ATTRIBUTION,
  type AttributionConfig,
  type ModelPrice,
} from "./types.ts";

export interface OverheadConfig {
  attribution: AttributionConfig;
  /** Feature name -> globs, for `--by feature`. */
  features: Record<string, string[]>;
  /** Per-model price overrides (partner pricing, negotiated rates). */
  prices: Record<string, ModelPrice>;
  /** Default directory depth for `--by dir`. */
  depth: number;
}

export const CONFIG_FILENAME = "overhead.config.json";

export const DEFAULT_CONFIG: OverheadConfig = {
  attribution: { ...DEFAULT_ATTRIBUTION },
  features: {},
  prices: {},
  depth: 2,
};

export function loadConfig(repoRoot: string): OverheadConfig {
  const path = join(repoRoot, CONFIG_FILENAME);
  if (!existsSync(path)) return { ...DEFAULT_CONFIG };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(
      `${CONFIG_FILENAME} is not valid JSON: ${(err as Error).message}`,
    );
  }
  const obj = (raw ?? {}) as Partial<OverheadConfig>;
  const cfg: OverheadConfig = {
    attribution: { ...DEFAULT_CONFIG.attribution, ...(obj.attribution ?? {}) },
    features: obj.features ?? {},
    prices: obj.prices ?? {},
    depth: obj.depth ?? DEFAULT_CONFIG.depth,
  };

  const { lambda, window } = cfg.attribution;
  if (!(lambda > 0 && lambda <= 1)) {
    throw new Error(`attribution.lambda must be in (0, 1]; got ${lambda}`);
  }
  if (!Number.isInteger(window) || window < 1) {
    throw new Error(`attribution.window must be a positive integer; got ${window}`);
  }
  return cfg;
}

export const SAMPLE_CONFIG = `{
  "attribution": {
    "lambda": 0.85,
    "window": 20
  },
  "depth": 2,
  "features": {
    "checkout": ["packages/checkout/**", "apps/web/src/checkout/**"],
    "auth": ["packages/auth/**", "services/identity/**"]
  },
  "prices": {}
}
`;
