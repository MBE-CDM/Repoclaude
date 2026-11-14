import type { ApiAssertion, AssertionResult, DiffExpectation, Op, SqlAssertion } from './assertions.js';

/** Extraction d'une valeur vers une variable réutilisable dans les étapes suivantes. */
export interface Extract {
  var: string;
  from: 'jsonpath' | 'header' | 'status' | 'column' | 'stdout' | 'regex' | 'url' | 'text' | 'attribute' | 'exitCode' | 'rowCount';
  path?: string; column?: string; row?: number; pattern?: string; group?: number; selector?: string; attribute?: string; name?: string;
}

interface StepBase {
  name?: string;
  continueOnFailure?: boolean;
  timeoutMs?: number;
  extract?: Extract[];
}

/* ---------- UI ---------- */
export type UiAction =
  | { action: 'goto'; url?: string }
  | { action: 'login'; profile: string }
  | { action: 'click' | 'dblclick' | 'hover' | 'check' | 'uncheck' | 'waitFor'; selector: string }
  | { action: 'fill'; selector: string; value: string }
  | { action: 'press'; selector?: string; key: string }
  | { action: 'select'; selector: string; value: string }
  | { action: 'expectText'; selector: string; text?: string; contains?: string }
  | { action: 'expectVisible' | 'expectHidden'; selector: string }
  | { action: 'expectUrl'; contains: string }
  | { action: 'expectTitle'; contains: string }
  | { action: 'extract'; var: string; selector: string; attribute?: string; pattern?: string }
  | { action: 'extractUrl'; var: string; pattern?: string }
  | { action: 'screenshot'; name?: string; fullPage?: boolean }
  | { action: 'wait'; ms: number };

export interface UiStep extends StepBase {
  type: 'ui';
  headless?: boolean;
  viewport?: { width: number; height: number };
  /** Conserve le navigateur ouvert entre étapes UI successives (même session). Défaut : true. */
  keepSession?: boolean;
  actions: UiAction[];
}

/* ---------- API ---------- */
export interface ApiStep extends StepBase {
  type: 'api';
  protocol?: 'rest' | 'graphql' | 'soap';
  method?: string;
  /** Relatif à apiUrl de l'environnement, ou absolu. */
  path: string;
  headers?: Record<string, string>;
  query?: Record<string, string>;
  body?: unknown;
  graphql?: { query: string; variables?: Record<string, unknown>; operationName?: string };
  soap?: { action?: string; envelope: string; version?: '1.1' | '1.2' };
  /** Authentification avec un compte de test de l'environnement. */
  auth?: { profile: string; mode: 'basic' } | { mode: 'bearer'; token: string };
  assertions?: ApiAssertion[];
}

/* ---------- SQL ---------- */
export type IntegrityCheck =
  | { kind: 'foreignKey'; table: string; column: string; refTable: string; refColumn: string; where?: string }
  | { kind: 'duplicates'; table: string; columns: string[]; where?: string }
  | { kind: 'notNull'; table: string; columns: string[]; where?: string }
  | { kind: 'consistency'; name?: string; left: string; right: string; op?: Op }
  | { kind: 'query'; name?: string; sql: string };

export interface SqlStep extends StepBase {
  type: 'sql';
  database: string;
  mode?: 'query' | 'script' | 'snapshot' | 'diff' | 'integrity' | 'savepoint' | 'rollbackTo' | 'procedure';
  /** Requête paramétrée : {{var}} → paramètre lié. MongoDB : commande JSON. */
  query?: string;
  assertions?: SqlAssertion[];
  /** mode snapshot : nom sous lequel mémoriser le résultat. */
  snapshot?: string;
  /** mode diff : rejoue la requête du snapshot et compare. */
  diff?: { snapshot: string; key: string[]; expect: DiffExpectation };
  integrity?: IntegrityCheck[];
  savepoint?: string;
  procedure?: { name: string; args?: unknown[] };
  allowDestructive?: boolean;
  /** Nombre max de lignes jointes en preuve (défaut 200). */
  evidenceRows?: number;
}

/* ---------- Scripts & batchs ---------- */
export type ScriptLanguage = 'shell' | 'powershell' | 'python' | 'sql';

export type Launcher =
  | { kind: 'ssh'; server: string; command: string }
  | { kind: 'agent'; agent: string; command: string; cwd?: string }
  | { kind: 'jenkins'; scheduler: string; job: string; parameters?: Record<string, string> }
  | { kind: 'gitlab'; scheduler: string; project: string; ref: string; variables?: Record<string, string> }
  | { kind: 'airflow'; scheduler: string; dag: string; conf?: Record<string, unknown> }
  | { kind: 'controlm'; scheduler: string; ctm: string; folder: string; jobs?: string };

export interface ScriptStep extends StepBase {
  type: 'script';
  language: ScriptLanguage;
  target: { server: string } | { agent: string } | { database: string };
  script: string;
  args?: string[];
  expectExitCode?: number;
  allowDestructive?: boolean;
}

export type FileSource = { share: string; path: string } | { server: string; path: string } | { agent: string; path: string };

export type FileFormat = 'csv' | 'json' | 'xml' | 'fixed' | 'text';

export interface FileSpec {
  source: FileSource;
  format?: FileFormat;
  encoding?: BufferEncoding;
  csv?: { delimiter?: string; header?: boolean; quote?: string };
  fixed?: { fields: { name: string; start: number; length: number }[]; skipLines?: number };
}

export type FileAssertion =
  | { type: 'exists' } | { type: 'notExists' }
  | { type: 'formatValid' }
  | { type: 'lineCount'; op?: Op; value: number }
  | { type: 'recordCount'; op?: Op; value: number }
  | { type: 'contains'; value: string } | { type: 'notContains'; value: string }
  | { type: 'regex'; pattern: string }
  | { type: 'field'; row?: number; field: string; op?: Op; value?: unknown }
  | { type: 'jsonpath'; path: string; op?: Op; value?: unknown }
  | { type: 'maxSize'; bytes: number }
  | { type: 'headers'; value: string[] }
  | { type: 'equalsFile'; other: FileSpec; key?: string[]; ignoreOrder?: boolean };

export interface FileCheck extends FileSpec { assertions: FileAssertion[] }

export interface BatchStep extends StepBase {
  type: 'batch';
  launcher: Launcher;
  wait?: boolean;
  expectExitCode?: number;
  /** Contrôle des fichiers produits. */
  files?: FileCheck[];
  /** Étapes de vérification enchaînées (ex. contrôle SQL de l'effet du batch). */
  then?: Step[];
}

export interface FileStep extends StepBase, FileSpec { type: 'file'; assertions: FileAssertion[] }

export type Step = UiStep | ApiStep | SqlStep | ScriptStep | BatchStep | FileStep;
export type StepType = Step['type'];

export interface Hook { database: string; script: string; allowDestructive?: boolean }

export interface TestCase {
  id: string;
  name: string;
  description?: string;
  tags?: string[];
  /** Environnement par défaut ; une campagne ou un lancement peut en imposer un autre. */
  environmentId?: string;
  /** Jeu de données : un objet, ou un tableau (le cas est rejoué pour chaque ligne). */
  dataset?: Record<string, unknown> | Record<string, unknown>[];
  setup?: Hook[];
  teardown?: Hook[];
  /** Bases dont toutes les écritures du cas sont annulées en fin de cas (rollback transactionnel). */
  transactional?: string[];
  steps: Step[];
}

export interface Campaign {
  id: string;
  name: string;
  environmentId: string;
  caseIds: string[];
  variables?: Record<string, unknown>;
  setup?: Hook[];
  teardown?: Hook[];
  stopOnFailure?: boolean;
  schedule?: { cron: string; enabled: boolean; timezone?: string };
  /** Empreinte SHA-256 du jeton de webhook (le jeton n'est affiché qu'à sa création). */
  webhookTokenHash?: string;
}

/* ---------- Résultats ---------- */
export type Status = 'queued' | 'running' | 'passed' | 'failed' | 'error' | 'blocked' | 'skipped' | 'cancelled';

export interface Evidence { type: 'screenshot' | 'video' | 'trace' | 'har' | 'console' | 'table' | 'json' | 'log' | 'file' | 'diff'; name: string; file?: string; data?: unknown }

export interface StepResult {
  index: string;
  name: string;
  type: StepType | 'hook';
  status: Status;
  startedAt: string;
  durationMs: number;
  assertions: AssertionResult[];
  logs: string[];
  evidence: Evidence[];
  outputs?: Record<string, unknown>;
  error?: string;
}

export interface CaseResult {
  caseId: string;
  name: string;
  datasetIndex?: number;
  status: Status;
  startedAt: string;
  durationMs: number;
  steps: StepResult[];
}

export interface Execution {
  id: string;
  kind: 'case' | 'campaign';
  refId: string;
  name: string;
  environmentId: string;
  environmentName: string;
  status: Status;
  trigger: 'manual' | 'schedule' | 'webhook' | 'api';
  triggeredBy: string;
  createdAt: string;
  startedAt?: string;
  endedAt?: string;
  cases: CaseResult[];
  error?: string;
  approvalId?: string;
}
