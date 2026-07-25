import type { Filesystem } from "@boxsh/sandbox";
import { rawSkillFileUrl } from "./github";
import { discoverInstalledSkills, initializeSkillWorkspace, SKILLS_ROOT } from "./runtime";
import {
  SkillImportError,
  type SkillFetch,
  type SkillImportPreview,
  type SkillInstallProgress,
} from "./types";
import { validateSkillMarkdown } from "./validation";

const MAX_FILE_SIZE = 10 * 1024 * 1024;
const MAX_BATCH_SIZE = 50 * 1024 * 1024;
const STAGING_ROOT = `${SKILLS_ROOT}/.staging`;

export interface SkillInstallOptions {
  fs: Filesystem;
  preview: SkillImportPreview;
  selectedIds: string[];
  confirmReplacements?: boolean;
  fetcher?: SkillFetch;
  onProgress?: (progress: SkillInstallProgress) => void;
  onMutate?: () => void;
  /** Deterministic failure hook used by the atomic-install tests. */
  beforePromote?: (name: string, index: number) => void | Promise<void>;
}

function operationId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `skill-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function removeIfPresent(fs: Filesystem, path: string): Promise<void> {
  if (await fs.exists(path)) await fs.rm(path, { recursive: true });
}

/** Drop the op directory, and the shared staging root once no ops remain. */
async function cleanupOperation(fs: Filesystem, opRoot: string): Promise<void> {
  await removeIfPresent(fs, opRoot);
  try {
    if ((await fs.readdir(STAGING_ROOT)).length === 0) {
      await fs.rm(STAGING_ROOT, { recursive: true });
    }
  } catch {
    // A concurrent operation owns the staging root; it cleans up last.
  }
}

async function downloadFile(
  fetcher: SkillFetch,
  url: string,
  path: string,
): Promise<Uint8Array> {
  let response: Response;
  try {
    response = await fetcher(url);
  } catch (cause) {
    throw new SkillImportError("network", `Could not download ${path}`, { cause });
  }
  if (!response.ok) {
    throw new SkillImportError(
      response.status === 429 ? "rate_limit" : "download_failed",
      `Could not download ${path} (${response.status})`,
    );
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length > MAX_FILE_SIZE) {
    throw new SkillImportError(
      "limit_exceeded",
      `${path} exceeds the 10 MiB file limit`,
    );
  }
  return bytes;
}

export async function installSkills(options: SkillInstallOptions): Promise<string[]> {
  const {
    fs,
    preview,
    selectedIds,
    confirmReplacements = false,
    fetcher = fetch,
    onProgress,
    onMutate,
    beforePromote,
  } = options;
  await initializeSkillWorkspace(fs);
  const selectedSet = new Set(selectedIds);
  const candidates = preview.candidates.filter((candidate) => selectedSet.has(candidate.id));
  if (
    candidates.length === 0 ||
    candidates.some((candidate) => !candidate.valid || !candidate.metadata)
  ) {
    throw new SkillImportError(
      "install_failed",
      "Select at least one valid skill to install",
    );
  }
  if (new Set(candidates.map((candidate) => candidate.metadata?.name)).size !== candidates.length) {
    throw new SkillImportError("install_failed", "Selected skill names must be unique");
  }

  const installed = new Set(
    (await discoverInstalledSkills(fs)).map((skill) => skill.name),
  );
  const conflicts = candidates
    .map((candidate) => candidate.metadata!.name)
    .filter((name) => installed.has(name));
  if (conflicts.length > 0 && !confirmReplacements) {
    throw new SkillImportError(
      "replacement_confirmation",
      "Confirm replacement before installing existing skills",
      { conflicts },
    );
  }

  const declaredBatchSize = candidates.reduce(
    (total, candidate) =>
      total +
      candidate.files.reduce((sum, file) => sum + (file.type === "blob" ? file.size ?? 0 : 0), 0),
    0,
  );
  if (declaredBatchSize > MAX_BATCH_SIZE) {
    throw new SkillImportError(
      "limit_exceeded",
      "The selected skills exceed the 50 MiB batch limit",
    );
  }

  const opRoot = `${STAGING_ROOT}/${operationId()}`;
  const stageRoot = `${opRoot}/next`;
  const backupRoot = `${opRoot}/backup`;
  await fs.mkdir(stageRoot, { recursive: true });
  await fs.mkdir(backupRoot, { recursive: true });
  let downloaded = 0;

  try {
    onProgress?.({
      phase: "found",
      message: `Found ${candidates.length} ${candidates.length === 1 ? "skill" : "skills"}`,
      count: candidates.length,
    });
    for (const [index, candidate] of candidates.entries()) {
      const name = candidate.metadata!.name;
      onProgress?.({
        phase: "installing",
        message: `Installing ${name} · ${index + 1} of ${candidates.length}`,
        name,
        current: index + 1,
        total: candidates.length,
      });
      const directory = candidate.skillFile.split("/").slice(0, -1).join("/");
      const prefix = directory ? `${directory}/` : "";
      for (const file of candidate.files) {
        if (file.type !== "blob") continue;
        const relative = file.path.slice(prefix.length);
        if (
          !relative ||
          relative.startsWith("/") ||
          relative.split("/").some((part) => !part || part === "." || part === "..")
        ) {
          throw new SkillImportError("install_failed", "A skill contains an unsafe path");
        }
        const bytes = await downloadFile(
          fetcher,
          rawSkillFileUrl(preview, file.path),
          file.path,
        );
        downloaded += bytes.length;
        if (downloaded > MAX_BATCH_SIZE) {
          throw new SkillImportError(
            "limit_exceeded",
            "The downloaded skills exceed the 50 MiB batch limit",
          );
        }
        const target = `${stageRoot}/${name}/${relative}`;
        const parent = target.split("/").slice(0, -1).join("/");
        await fs.mkdir(parent, { recursive: true });
        await fs.writeFile(target, bytes);
      }

      const markdown = await fs.readFile(`${stageRoot}/${name}/SKILL.md`, "utf-8");
      const validated = validateSkillMarkdown(markdown, name);
      if (!validated.valid) {
        throw new SkillImportError(
          "install_failed",
          `${name} changed after discovery and is no longer valid`,
          { issues: validated.issues },
        );
      }
    }
  } catch (error) {
    await cleanupOperation(fs, opRoot);
    throw error;
  }

  const movedBackups: string[] = [];
  const promoted: string[] = [];
  try {
    for (const [index, candidate] of candidates.entries()) {
      const name = candidate.metadata!.name;
      await beforePromote?.(name, index);
      const target = `${SKILLS_ROOT}/${name}`;
      if (await fs.exists(target)) {
        await fs.rename(target, `${backupRoot}/${name}`);
        movedBackups.push(name);
      }
      await fs.rename(`${stageRoot}/${name}`, target);
      promoted.push(name);
    }
    await cleanupOperation(fs, opRoot);
    onMutate?.();
    return candidates.map((candidate) => candidate.metadata!.name);
  } catch (cause) {
    let rollbackError: unknown;
    try {
      for (const name of promoted.reverse()) {
        await removeIfPresent(fs, `${SKILLS_ROOT}/${name}`);
      }
      for (const name of movedBackups.reverse()) {
        const backup = `${backupRoot}/${name}`;
        if (await fs.exists(backup)) {
          await fs.rename(backup, `${SKILLS_ROOT}/${name}`);
        }
      }
      await cleanupOperation(fs, opRoot);
    } catch (error) {
      rollbackError = error;
    }
    if (movedBackups.length > 0 || promoted.length > 0) onMutate?.();
    throw new SkillImportError(
      "install_failed",
      rollbackError
        ? "Installation failed and the rollback could not be completed"
        : "Installation failed; previous skills were restored",
      { cause: rollbackError ?? cause },
    );
  }
}

export async function removeInstalledSkill(
  fs: Filesystem,
  name: string,
  onMutate?: () => void,
): Promise<boolean> {
  const target = `${SKILLS_ROOT}/${name}`;
  if (!(await fs.exists(target))) return false;
  await fs.rm(target, { recursive: true });
  onMutate?.();
  return true;
}
