/**
 * OmpSkills — skill-mention rewriting for Oh-My-Pi / Pi.
 *
 * Pi surfaces skills as `/skill:<name>` commands via `get_commands`; the T3
 * composer inserts `$name`. The adapter caches the live skill names per
 * session and rewrites known mentions so the harness sees its own form.
 * Unknown `$mentions` pass through untouched.
 */
const SKILL_MENTION_PATTERN = /(^|\s)\$([a-zA-Z][a-zA-Z0-9:_-]*)(?=\s|$)/g;
const HAS_SKILL_MENTION_PATTERN = /(^|\s)\$[a-zA-Z][a-zA-Z0-9:_-]*(?=\s|$)/;

export function hasOmpSkillMention(prompt: string): boolean {
  return HAS_SKILL_MENTION_PATTERN.test(prompt);
}

export function rewriteOmpSkillMentions(prompt: string, skillNames: ReadonlySet<string>): string {
  return prompt.replace(SKILL_MENTION_PATTERN, (match, prefix: string, name: string) =>
    skillNames.has(name) ? `${prefix}/skill:${name}` : match,
  );
}
