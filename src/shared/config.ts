import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

const CodeRootSchema = z.object({
  name: z.string(),
  path: z.string(),
  gitRemote: z.string().default("origin"),
  defaultBranch: z.string().default("master"),
  gitlabProjectPath: z.string(),
});

const DatabaseSchema = z.object({
  name: z.string(),
  driverType: z.enum(["mysql", "postgres", "doris"]).default("mysql"),
  host: z.string(),
  port: z.number(),
  username: z.string(),
  password: z.string(),
  dbName: z.string(),
  readonly: z.boolean().default(true),
});

const ElasticsearchSchema = z.object({
  url: z.string(),
  indices: z.array(z.string()),
  errorQuery: z.string().default("level:ERROR"),
});

const EnvironmentSchema = z.object({
  name: z.string(),
  type: z.enum(["prod", "test", "dev"]),
  elasticsearch: ElasticsearchSchema,
  logFiles: z.array(z.string()).default([]),
  databases: z.array(DatabaseSchema).default([]),
  codeRoots: z.array(CodeRootSchema),
});

const GitlabSchema = z.object({
  url: z.string(),
  token: z.string(),
  defaultTargetBranch: z.string().default("master"),
});

const ClaudeSchema = z.object({
  apiKey: z.string(),
  baseUrl: z.string(),
  model: z.string().default("claude-sonnet-4-20250514"),
});

const IssueWatcherSchema = z.object({
  enabled: z.boolean().default(false),
  label: z.string().default("ai-dev"),
  issuePollingInterval: z.number().default(30000),       // ms
  commentPollingInterval: z.number().default(60000),     // ms
  claudeTimeout: z.number().default(1800000),            // 30 min
  claudeBin: z.string().default("claude"),
  claudeExtraArgs: z.array(z.string()).default([]),
  preferEnv: z.string().default("testing"),
  maxIterations: z.number().default(20),
  maxConcurrent: z.number().default(3),
});

const WatcherSchema = z.object({
  esPollingInterval: z.number().default(30),
  dedupeWindow: z.number().default(3600),
  maxConcurrentFixes: z.number().default(3),
  riskAutoFix: z.array(z.string()).default(["A", "B"]),
  mrCommentPollingInterval: z.number().default(60000), // 默认 60 秒（毫秒）
  issueWatcher: IssueWatcherSchema.default({}),
});

const StorageSchema = z.object({
  type: z.literal("sqlite").default("sqlite"),
  path: z.string().default("./data/incidents.db"),
});

const ConfigSchema = z.object({
  environments: z.array(EnvironmentSchema),
  gitlab: GitlabSchema,
  claude: ClaudeSchema,
  watcher: WatcherSchema,
  storage: StorageSchema,
});

export type Config = z.infer<typeof ConfigSchema>;
export type Environment = z.infer<typeof EnvironmentSchema>;
export type CodeRoot = z.infer<typeof CodeRootSchema>;
export type DatabaseConfig = z.infer<typeof DatabaseSchema>;

function interpolateEnvVars(text: string): string {
  return text.replace(/\$\{(\w+)\}/g, (_, varName) => {
    return process.env[varName] ?? "";
  });
}

let cachedConfig: Config | null = null;

export function loadConfig(configPath?: string): Config {
  if (cachedConfig) return cachedConfig;

  const dir = import.meta.dirname ?? process.cwd();
  const projectRoot = dir.includes("src") ? resolve(dir, "../..") : dir;
  const localPath = configPath ?? resolve(projectRoot, "config.local.yaml");
  const examplePath = resolve(projectRoot, "config.example.yaml");

  const filePath = existsSync(localPath) ? localPath : examplePath;
  if (!existsSync(filePath)) {
    throw new Error(`Config file not found: ${localPath} or ${examplePath}`);
  }

  const raw = readFileSync(filePath, "utf-8");
  const interpolated = interpolateEnvVars(raw);
  const parsed = parseYaml(interpolated);
  cachedConfig = ConfigSchema.parse(parsed);
  return cachedConfig;
}

export function getEnvironment(config: Config, envName: string): Environment {
  const env = config.environments.find((e) => e.name === envName);
  if (!env) throw new Error(`Environment not found: ${envName}`);
  return env;
}

export function getCodeRoot(env: Environment, rootName: string): CodeRoot {
  const root = env.codeRoots.find((r) => r.name === rootName);
  if (!root) throw new Error(`Code root not found: ${rootName} in env ${env.name}`);
  return root;
}
