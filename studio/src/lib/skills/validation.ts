import { parseDocument } from "yaml";
import type { SkillIssue, SkillMetadata } from "./types";

const FRONTMATTER = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)([\s\S]*)$/;
const NAME = /^(?!-)(?!.*--)[a-z0-9-]{1,64}(?<!-)$/;

export interface SkillValidationResult {
  valid: boolean;
  metadata?: SkillMetadata;
  body: string;
  issues: SkillIssue[];
  warnings: SkillIssue[];
}

const issue = (code: string, message: string): SkillIssue => ({ code, message });

function optionalString(
  value: unknown,
  field: string,
  max?: number,
): SkillIssue | undefined {
  if (typeof value !== "string") {
    return issue(`invalid_${field}`, `${field} must be a string`);
  }
  if (value.length === 0 || (max !== undefined && value.length > max)) {
    return issue(
      `invalid_${field}`,
      max === undefined
        ? `${field} must not be empty`
        : `${field} must be 1–${max} characters`,
    );
  }
}

export function validateSkillMarkdown(
  content: string,
  sourceDirectory: string,
): SkillValidationResult {
  const issues: SkillIssue[] = [];
  const warnings: SkillIssue[] = [];
  const match = content.match(FRONTMATTER);
  if (!match) {
    return {
      valid: false,
      body: "",
      issues: [issue("missing_frontmatter", "SKILL.md needs YAML frontmatter")],
      warnings,
    };
  }

  const [, yaml, body = ""] = match;
  const document = parseDocument(yaml, {
    prettyErrors: false,
    uniqueKeys: true,
  });
  if (document.errors.length > 0) {
    return {
      valid: false,
      body,
      issues: [
        issue(
          "invalid_yaml",
          `Invalid YAML frontmatter: ${document.errors[0]?.message ?? "parse error"}`,
        ),
      ],
      warnings,
    };
  }

  const data = document.toJS() as unknown;
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return {
      valid: false,
      body,
      issues: [issue("invalid_frontmatter", "Frontmatter must be a YAML mapping")],
      warnings,
    };
  }

  const fields = data as Record<string, unknown>;
  const name = fields.name;
  const description = fields.description;
  if (typeof name !== "string" || !NAME.test(name)) {
    issues.push(
      issue(
        "invalid_name",
        "name must be 1–64 lowercase letters, numbers, or single hyphens",
      ),
    );
  } else if (name !== sourceDirectory) {
    issues.push(
      issue("name_mismatch", `name must match its source directory (${sourceDirectory})`),
    );
  }

  if (
    typeof description !== "string" ||
    description.length < 1 ||
    description.length > 1024
  ) {
    issues.push(issue("invalid_description", "description must be 1–1024 characters"));
  }

  if ("license" in fields) {
    const found = optionalString(fields.license, "license");
    if (found) issues.push(found);
  }
  if ("compatibility" in fields) {
    const found = optionalString(fields.compatibility, "compatibility", 500);
    if (found) issues.push(found);
  }
  if ("allowed-tools" in fields) {
    const found = optionalString(fields["allowed-tools"], "allowed-tools");
    if (found) issues.push(found);
  }
  if ("metadata" in fields) {
    const metadata = fields.metadata;
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
      issues.push(issue("invalid_metadata", "metadata must be a string-to-string mapping"));
    } else if (
      Object.entries(metadata).some(
        ([key, value]) => key.length === 0 || typeof value !== "string",
      )
    ) {
      issues.push(issue("invalid_metadata", "metadata keys and values must be strings"));
    }
  }

  if (body.trim().length === 0) {
    issues.push(issue("empty_body", "SKILL.md needs a non-empty Markdown body"));
  }

  const lines = content.split(/\r?\n/).length;
  if (lines > 500) {
    warnings.push(
      issue("long_skill", `SKILL.md has ${lines} lines; 500 or fewer is recommended`),
    );
  }

  const metadata: SkillMetadata | undefined =
    typeof name === "string" && typeof description === "string"
      ? {
          name,
          description,
          ...(typeof fields.license === "string" ? { license: fields.license } : {}),
          ...(typeof fields.compatibility === "string"
            ? { compatibility: fields.compatibility }
            : {}),
          ...(fields.metadata &&
          typeof fields.metadata === "object" &&
          !Array.isArray(fields.metadata)
            ? { metadata: fields.metadata as Record<string, string> }
            : {}),
          ...(typeof fields["allowed-tools"] === "string"
            ? { allowedTools: fields["allowed-tools"] }
            : {}),
        }
      : undefined;

  return {
    valid: issues.length === 0,
    metadata,
    body,
    issues,
    warnings,
  };
}

export function stripSkillFrontmatter(content: string): string | undefined {
  const match = content.match(FRONTMATTER);
  return match?.[2]?.trim();
}

export function isValidSkillName(name: string): boolean {
  return NAME.test(name);
}
