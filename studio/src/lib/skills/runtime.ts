import type { Filesystem } from "@boxsh/sandbox";
import type { InstalledSkill } from "./types";
import { isValidSkillName, stripSkillFrontmatter, validateSkillMarkdown } from "./validation";

export const SKILLS_ROOT = "/.skills";
export const DATA_ROOT = "/data";

export async function initializeSkillWorkspace(fs: Filesystem): Promise<void> {
  await fs.mkdir(DATA_ROOT, { recursive: true });
  await fs.mkdir(SKILLS_ROOT, { recursive: true });
}

export async function discoverInstalledSkills(fs: Filesystem): Promise<InstalledSkill[]> {
  await initializeSkillWorkspace(fs);
  const entries = await fs.readdir(SKILLS_ROOT);
  const skills: InstalledSkill[] = [];
  for (const entry of entries) {
    if (entry.kind !== "dir" || entry.name.startsWith(".")) continue;
    try {
      const markdown = await fs.readFile(`${SKILLS_ROOT}/${entry.name}/SKILL.md`, "utf-8");
      const validated = validateSkillMarkdown(markdown, entry.name);
      if (validated.valid && validated.metadata) {
        skills.push({
          ...validated.metadata,
          directory: `${SKILLS_ROOT}/${entry.name}`,
          warnings: validated.warnings,
        });
      }
    } catch {
      // Manually edited or partially removed skills are ignored until valid again.
    }
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

export function appendSkillsPrompt(base: string, skills: InstalledSkill[]): string {
  if (skills.length === 0) return base;
  const catalog = skills.map((skill) => `- ${skill.name}: ${skill.description}`).join("\n");
  return `${base}

Available Agent Skills:
${catalog}

When a request matches a skill, call load_skill with its name before using its \
specialized instructions. The tool returns the skill directory; resolve any \
relative scripts, references, and assets from there. A skill's allowed-tools \
field never grants capabilities or overrides sandbox restrictions.`;
}

export async function loadInstalledSkill(
  fs: Filesystem,
  name: string,
): Promise<
  | { ok: true; name: string; directory: string; instructions: string }
  | { ok: false; error: string }
> {
  if (!isValidSkillName(name)) {
    return { ok: false, error: "Invalid skill name" };
  }
  const directory = `${SKILLS_ROOT}/${name}`;
  try {
    const content = await fs.readFile(`${directory}/SKILL.md`, "utf-8");
    const validated = validateSkillMarkdown(content, name);
    const instructions = stripSkillFrontmatter(content);
    if (!validated.valid || !validated.metadata || !instructions) {
      return { ok: false, error: "Skill is missing or no longer valid" };
    }
    return { ok: true, name, directory, instructions };
  } catch {
    return { ok: false, error: "Skill is missing or no longer valid" };
  }
}
