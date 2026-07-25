export interface SkillMetadata {
  name: string;
  description: string;
  license?: string;
  compatibility?: string;
  metadata?: Record<string, string>;
  allowedTools?: string;
}

export interface SkillIssue {
  code: string;
  message: string;
  path?: string;
}

export interface SkillTreeEntry {
  path: string;
  mode: string;
  type: "blob" | "tree" | "commit";
  size?: number;
  sha: string;
}

export interface SkillCandidate {
  id: string;
  sourceDirectory: string;
  skillFile: string;
  metadata?: SkillMetadata;
  files: SkillTreeEntry[];
  valid: boolean;
  selected: boolean;
  replacing: boolean;
  ambiguous: boolean;
  issues: SkillIssue[];
  warnings: SkillIssue[];
}

export interface SkillImportPreview {
  url: string;
  owner: string;
  repo: string;
  ref: string;
  commit: string;
  selectedPath: string;
  candidates: SkillCandidate[];
}

export type SkillInstallProgress =
  | { phase: "checking"; message: string }
  | { phase: "found"; message: string; count: number }
  | {
      phase: "installing";
      message: string;
      name: string;
      current: number;
      total: number;
    }
  | { phase: "error"; message: string };

export interface InstalledSkill extends SkillMetadata {
  directory: string;
  warnings: SkillIssue[];
}

export type SkillImportErrorCode =
  | "invalid_url"
  | "not_found"
  | "rate_limit"
  | "network"
  | "invalid_repository"
  | "truncated_tree"
  | "limit_exceeded"
  | "replacement_confirmation"
  | "download_failed"
  | "install_failed";

export class SkillImportError extends Error {
  readonly code: SkillImportErrorCode;
  readonly issues: SkillIssue[];
  readonly conflicts: string[];

  constructor(
    code: SkillImportErrorCode,
    message: string,
    options?: { issues?: SkillIssue[]; conflicts?: string[]; cause?: unknown },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "SkillImportError";
    this.code = code;
    this.issues = options?.issues ?? [];
    this.conflicts = options?.conflicts ?? [];
  }
}

export type SkillFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;
