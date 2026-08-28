import { loadSchedulerConfig, parseModels, requiredEnv, type SchedulerConfig } from "@scheduler/shared";

export const DEFAULT_QODER_MODELS = [
  "lite",
  "efficient",
  "auto",
  "performance",
  "ultimate",
] as const;

export interface QoderConfig extends SchedulerConfig {
  readonly accessToken: string;
  readonly models: readonly string[];
  readonly projectRoot: string;
}

export function loadQoderConfig(projectRoot: string): QoderConfig {
  const models = parseModels(process.env.MODELS, DEFAULT_QODER_MODELS);
  if (!models) throw new Error("Unable to resolve Qoder models.");
  return {
    ...loadSchedulerConfig(),
    accessToken: requiredEnv("ACCESS_TOKEN"),
    models,
    projectRoot,
  };
}
