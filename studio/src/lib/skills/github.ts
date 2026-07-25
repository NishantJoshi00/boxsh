import type { Filesystem } from "@boxsh/sandbox";
import {
  SkillImportError,
  type SkillCandidate,
  type SkillFetch,
  type SkillImportPreview,
  type SkillIssue,
  type SkillTreeEntry,
} from "./types";
import { discoverInstalledSkills } from "./runtime";
import { validateSkillMarkdown } from "./validation";

const API = "https://api.github.com";
const RAW = "https://raw.githubusercontent.com";
const MAX_CANDIDATES = 100;
const MAX_FILES = 500;
const MAX_FILE_SIZE = 10 * 1024 * 1024;

interface GitHubTarget {
  owner: string;
  repo: string;
  treeParts?: string[];
}

interface GitHubTreeResponse {
  truncated: boolean;
  tree: SkillTreeEntry[];
}

const issue = (code: string, message: string, path?: string): SkillIssue => ({
  code,
  message,
  ...(path ? { path } : {}),
});

function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

function parseGitHubUrl(value: string): GitHubTarget {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new SkillImportError("invalid_url", "Enter a valid public GitHub URL");
  }
  if (
    url.protocol !== "https:" ||
    url.hostname.toLowerCase() !== "github.com" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new SkillImportError(
      "invalid_url",
      "Use an HTTPS URL from github.com without query parameters",
    );
  }

  let parts: string[];
  try {
    parts = url.pathname
      .split("/")
      .filter(Boolean)
      .map((part) => decodeURIComponent(part));
  } catch {
    throw new SkillImportError("invalid_url", "The GitHub URL contains malformed text");
  }
  if (parts.length < 2) {
    throw new SkillImportError("invalid_url", "The URL must point to a GitHub repository");
  }
  const [owner, rawRepo, kind, ...rest] = parts;
  const repo = rawRepo?.replace(/\.git$/, "");
  if (!owner || !repo || [owner, repo].some((part) => part === "." || part === "..")) {
    throw new SkillImportError("invalid_url", "The repository owner or name is invalid");
  }
  if (kind === undefined) return { owner, repo };
  if (kind !== "tree" || rest.length === 0 || rest.length > 100) {
    throw new SkillImportError(
      "invalid_url",
      "Use a repository root or a GitHub tree URL",
    );
  }
  return { owner, repo, treeParts: rest };
}

async function githubResponse(
  fetcher: SkillFetch,
  url: string,
  allowNotFound = false,
): Promise<Response | undefined> {
  let response: Response;
  try {
    response = await fetcher(url, {
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
  } catch (cause) {
    throw new SkillImportError("network", "GitHub could not be reached", { cause });
  }
  if (response.ok) return response;
  if (allowNotFound && response.status === 404) return undefined;
  if (
    response.status === 429 ||
    (response.status === 403 && response.headers.get("x-ratelimit-remaining") === "0")
  ) {
    throw new SkillImportError(
      "rate_limit",
      "GitHub’s public API rate limit was reached. Try again later.",
    );
  }
  if (response.status === 404) {
    throw new SkillImportError("not_found", "The public repository could not be found");
  }
  throw new SkillImportError(
    "invalid_repository",
    `GitHub returned ${response.status} while checking the repository`,
  );
}

async function githubJson<T>(
  fetcher: SkillFetch,
  url: string,
  allowNotFound = false,
): Promise<T | undefined> {
  const response = await githubResponse(fetcher, url, allowNotFound);
  if (!response) return undefined;
  try {
    return (await response.json()) as T;
  } catch (cause) {
    throw new SkillImportError("invalid_repository", "GitHub returned malformed data", {
      cause,
    });
  }
}

async function resolveTarget(
  target: GitHubTarget,
  fetcher: SkillFetch,
): Promise<{ ref: string; commit: string; selectedPath: string }> {
  const base = `${API}/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}`;
  if (!target.treeParts) {
    const repo = await githubJson<{ default_branch?: string }>(fetcher, base);
    if (!repo?.default_branch) {
      throw new SkillImportError(
        "invalid_repository",
        "The repository has no default branch",
      );
    }
    const commit = await githubJson<{ sha?: string }>(
      fetcher,
      `${base}/commits/${encodeURIComponent(repo.default_branch)}`,
    );
    if (!commit?.sha) {
      throw new SkillImportError("invalid_repository", "The default branch has no commit");
    }
    return { ref: repo.default_branch, commit: commit.sha, selectedPath: "" };
  }

  // A tree URL does not delimit a slash-containing ref from its path. Test the
  // longest possible ref first, then move the boundary left until GitHub
  // resolves a branch, tag, or commit.
  for (let split = target.treeParts.length; split >= 1; split--) {
    const ref = target.treeParts.slice(0, split).join("/");
    const found = await githubJson<{ sha?: string }>(
      fetcher,
      `${base}/commits/${encodeURIComponent(ref)}`,
      true,
    );
    if (found?.sha) {
      return {
        ref,
        commit: found.sha,
        selectedPath: target.treeParts.slice(split).join("/"),
      };
    }
  }
  throw new SkillImportError(
    "not_found",
    "No branch, tag, or commit in the GitHub URL could be resolved",
  );
}

function malformedPath(path: string): boolean {
  return (
    path.length === 0 ||
    path.startsWith("/") ||
    path.endsWith("/") ||
    path.includes("\\") ||
    path.split("/").some((part) => part === "" || part === "." || part === "..")
  );
}

async function fetchRawText(
  fetcher: SkillFetch,
  owner: string,
  repo: string,
  commit: string,
  path: string,
): Promise<string> {
  const url = `${RAW}/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${encodeURIComponent(commit)}/${encodePath(path)}`;
  let response: Response;
  try {
    response = await fetcher(url);
  } catch (cause) {
    throw new SkillImportError("network", "A skill file could not be downloaded", {
      cause,
    });
  }
  if (!response.ok) {
    throw new SkillImportError(
      "download_failed",
      `Could not download ${path} (${response.status})`,
    );
  }
  return response.text();
}

export async function discoverGitHubSkills(
  url: string,
  options: { fs: Filesystem; fetcher?: SkillFetch },
): Promise<SkillImportPreview> {
  const fetcher = options.fetcher ?? fetch;
  const target = parseGitHubUrl(url.trim());
  const resolved = await resolveTarget(target, fetcher);
  const base = `${API}/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}`;
  const tree = await githubJson<GitHubTreeResponse>(
    fetcher,
    `${base}/git/trees/${encodeURIComponent(resolved.commit)}?recursive=1`,
  );
  if (!tree || !Array.isArray(tree.tree)) {
    throw new SkillImportError("invalid_repository", "The Git tree is malformed");
  }
  if (tree.truncated) {
    throw new SkillImportError(
      "truncated_tree",
      "The repository tree is too large to import safely",
    );
  }
  if (tree.tree.some((entry) => malformedPath(entry.path))) {
    throw new SkillImportError(
      "invalid_repository",
      "The repository contains a malformed path",
    );
  }

  const prefix = resolved.selectedPath
    ? `${resolved.selectedPath.replace(/^\/+|\/+$/g, "")}/`
    : "";
  const skillFiles = tree.tree.filter((entry) => {
    if (entry.type !== "blob" || !entry.path.startsWith(prefix)) return false;
    return entry.path.split("/").pop()?.toLowerCase() === "skill.md";
  });
  if (skillFiles.length > MAX_CANDIDATES) {
    throw new SkillImportError(
      "limit_exceeded",
      `The selected path contains more than ${MAX_CANDIDATES} skill candidates`,
    );
  }

  const installed = new Set(
    (await discoverInstalledSkills(options.fs)).map((skill) => skill.name),
  );
  const candidates: SkillCandidate[] = [];
  for (const skillFile of skillFiles) {
    const segments = skillFile.path.split("/");
    const filename = segments.pop() ?? "";
    const sourceDirectory = segments.at(-1) ?? target.repo;
    const directory = segments.join("/");
    const filePrefix = directory ? `${directory}/` : "";
    const files = tree.tree.filter(
      (entry) => entry.type !== "tree" && entry.path.startsWith(filePrefix),
    );
    const issues: SkillIssue[] = [];
    let warnings: SkillIssue[] = [];

    if (filename !== "SKILL.md") {
      issues.push(issue("invalid_filename", "The filename must be exactly SKILL.md"));
    }
    if (files.some((entry) => entry.type === "commit" || entry.mode === "160000")) {
      issues.push(issue("submodule", "Skill folders cannot contain submodules"));
    }
    if (files.some((entry) => entry.mode === "120000")) {
      issues.push(issue("symlink", "Skill folders cannot contain symlinks"));
    }
    if (files.length > MAX_FILES) {
      issues.push(issue("too_many_files", `A skill may contain at most ${MAX_FILES} files`));
    }
    const oversized = files.find((entry) => (entry.size ?? 0) > MAX_FILE_SIZE);
    if (oversized) {
      issues.push(
        issue("file_too_large", "A skill file exceeds the 10 MiB limit", oversized.path),
      );
    }

    let metadata;
    if (filename === "SKILL.md") {
      try {
        const markdown = await fetchRawText(
          fetcher,
          target.owner,
          target.repo,
          resolved.commit,
          skillFile.path,
        );
        const validated = validateSkillMarkdown(markdown, sourceDirectory);
        metadata = validated.metadata;
        issues.push(...validated.issues);
        warnings = validated.warnings;
      } catch (error) {
        if (error instanceof SkillImportError) throw error;
        issues.push(issue("invalid_skill", "SKILL.md could not be validated"));
      }
    }

    candidates.push({
      id: skillFile.path,
      sourceDirectory,
      skillFile: skillFile.path,
      metadata,
      files,
      valid: issues.length === 0 && metadata !== undefined,
      selected: issues.length === 0 && metadata !== undefined,
      replacing: metadata ? installed.has(metadata.name) : false,
      ambiguous: false,
      issues,
      warnings,
    });
  }

  const names = new Map<string, SkillCandidate[]>();
  for (const candidate of candidates) {
    if (!candidate.metadata) continue;
    const group = names.get(candidate.metadata.name) ?? [];
    group.push(candidate);
    names.set(candidate.metadata.name, group);
  }
  for (const [name, group] of names) {
    if (group.length < 2) continue;
    for (const candidate of group) {
      candidate.ambiguous = true;
      candidate.valid = false;
      candidate.selected = false;
      candidate.issues.push(
        issue(
          "ambiguous_name",
          `Multiple folders use the name ${name}; import a direct folder URL`,
        ),
      );
    }
  }

  return {
    url: url.trim(),
    owner: target.owner,
    repo: target.repo,
    ref: resolved.ref,
    commit: resolved.commit,
    selectedPath: resolved.selectedPath,
    candidates,
  };
}

export function rawSkillFileUrl(
  preview: SkillImportPreview,
  path: string,
): string {
  return `${RAW}/${encodeURIComponent(preview.owner)}/${encodeURIComponent(preview.repo)}/${encodeURIComponent(preview.commit)}/${encodePath(path)}`;
}
