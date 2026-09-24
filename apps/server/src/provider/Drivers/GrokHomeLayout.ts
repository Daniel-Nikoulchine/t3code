import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";

export const GROK_MANAGED_SECTION_MARKER = "# Managed by T3 Code model routing; do not edit.";

export interface GrokRoutedModelEntry {
  readonly slug: string;
  readonly model: string;
  readonly baseUrl: string;
  readonly apiKey?: string | undefined;
}

const headerFor = (slug: string): string => `[model."${slug}"]`;

const escapeTomlString = (value: string): string =>
  `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

const renderEntry = (entry: GrokRoutedModelEntry): string => {
  const lines = [
    headerFor(entry.slug),
    GROK_MANAGED_SECTION_MARKER,
    `model = ${escapeTomlString(entry.model)}`,
    `base_url = ${escapeTomlString(entry.baseUrl)}`,
  ];
  if (entry.apiKey && entry.apiKey.length > 0) {
    lines.push(`api_key = ${escapeTomlString(entry.apiKey)}`);
  }
  return `${lines.join("\n")}\n`;
};

// Split a TOML document into [headerLineIndex | header | body] spans. The
// preamble before the first header is kept as its own span with a null
// header. Line based on purpose: full TOML parsing would reject files the
// grok CLI itself still reads leniently, and the merge below only ever
// rewrites spans it owns.
const splitSections = (toml: string): Array<{ header: string | null; text: string }> => {
  const lines = toml.split("\n");
  const sections: Array<{ header: string | null; text: string }> = [];
  let currentHeader: string | null = null;
  let current: Array<string> = [];
  for (const line of lines) {
    if (/^\s*\[[^\]]+\]\s*$/.test(line) && !/^\s*#/.test(line)) {
      sections.push({ header: currentHeader, text: current.join("\n") });
      currentHeader = line.trim();
      current = [line];
    } else {
      current.push(line);
    }
  }
  sections.push({ header: currentHeader, text: current.join("\n") });
  return sections;
};

export const mergeGrokBackendConfigToml = (
  userToml: string | undefined,
  entries: ReadonlyArray<GrokRoutedModelEntry>,
): string => {
  const bySlug = new Map(entries.map((entry) => [entry.slug, entry]));
  const sections = splitSections(userToml ?? "");
  const out: Array<string> = [];
  const written = new Set<string>();
  for (const section of sections) {
    if (section.header === null) {
      out.push(section.text);
      continue;
    }
    const match = /^\s*\[model\."((?:[^"\\]|\\.)*)"\]\s*$/.exec(section.header);
    const slug = match?.[1];
    if (slug === undefined || !bySlug.has(slug)) {
      // Not one of ours: drop only stale managed spans, keep user content.
      if (slug !== undefined && section.text.includes(GROK_MANAGED_SECTION_MARKER)) continue;
      out.push(section.text);
      continue;
    }
    if (section.text.includes(GROK_MANAGED_SECTION_MARKER)) {
      if (!written.has(slug)) {
        const entry = bySlug.get(slug);
        if (entry) out.push(renderEntry(entry).replace(/\n$/, ""));
        written.add(slug);
      }
      // Extra copies of an owned span collapse into the first.
      continue;
    }
    // The user defined this slug themselves: keep theirs, skip ours so the
    // file never ends up with a duplicate table.
    out.push(section.text);
    written.add(slug);
  }
  for (const entry of entries) {
    if (!written.has(entry.slug)) out.push(renderEntry(entry).replace(/\n$/, ""));
  }
  const merged = out
    .join("\n")
    .replace(/^\s*\n/, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n");
  return merged.endsWith("\n") ? merged : `${merged}\n`;
};

export interface GrokBackendHomeInput {
  readonly realHomePath: string;
  readonly shadowHomePath: string;
  readonly entries: ReadonlyArray<GrokRoutedModelEntry>;
}

export interface GrokBackendHome {
  readonly shadowHomePath: string;
  readonly shadowConfigPath: string;
}

// Shadow home for a backend wired grok instance. Grok keeps sessions,
// skills and its login under GROK_HOME with no overlay mechanism of its
// own, so the shadow home links every shared entry back to the real home
// and only config.toml is a real file: the user's config merged with one
// managed `[model.<slug>]` section per routed entry. Sessions keep working
// because the linked directories are the same on disk, and the real home
// is never written to.
export const ensureGrokBackendHome = Effect.fn("ensureGrokBackendHome")(function* (
  input: GrokBackendHomeInput,
): Effect.fn.Return<
  GrokBackendHome,
  PlatformError.PlatformError,
  FileSystem.FileSystem | Path.Path
> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fileSystem.makeDirectory(input.shadowHomePath, { recursive: true });
  const realEntries = yield* fileSystem
    .readDirectory(input.realHomePath)
    .pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<string>));
  for (const name of realEntries) {
    if (name === "config.toml") continue;
    const linkPath = path.join(input.shadowHomePath, name);
    const existing = yield* fileSystem.exists(linkPath);
    if (!existing) {
      yield* fileSystem.symlink(path.join(input.realHomePath, name), linkPath);
    }
  }
  const userToml = yield* fileSystem
    .readFileString(path.join(input.realHomePath, "config.toml"))
    .pipe(
      Effect.asSome,
      Effect.orElseSucceed(() => Option.none<string>()),
    );
  const shadowConfigPath = path.join(input.shadowHomePath, "config.toml");
  yield* fileSystem.writeFileString(
    shadowConfigPath,
    mergeGrokBackendConfigToml(Option.getOrUndefined(userToml), input.entries),
  );
  return { shadowHomePath: input.shadowHomePath, shadowConfigPath };
});
