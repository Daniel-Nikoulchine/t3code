import * as NodeOS from "node:os";

import {
  ProviderDriverKind,
  type CodexSettings,
  type ModelBackendConfig,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as PlatformError from "effect/PlatformError";

import { expandHomePath } from "../../pathExpansion.ts";
import { DEFAULT_BACKEND_PROTOCOLS } from "../ModelBackendEnvironment.ts";

export interface CodexHomeLayout {
  readonly mode: "direct" | "authOverlay";
  readonly sharedHomePath: string;
  readonly effectiveHomePath: string | undefined;
  readonly continuationKey: string;
}

const KNOWN_SHARED_DIRECTORIES = [
  "sessions",
  "archived_sessions",
  "sqlite",
  "shell_snapshots",
  "worktrees",
  "skills",
  "plugins",
  "cache",
  "logs",
  "mcp-oauth-locks",
] as const;

const PRIVATE_ENTRY_NAMES = new Set(["auth.json", "models_cache.json"]);
const SHADOW_LOCAL_ENTRY_NAMES = new Set(["log", "memories", "tmp"]);
const REPLACEABLE_SHARED_RUNTIME_DIRECTORIES = new Set(["mcp-oauth-locks"]);

function resolveHomePath(path: Path.Path, value: string | undefined): string {
  const expanded =
    value && value.trim().length > 0
      ? expandHomePath(value)
      : path.join(NodeOS.homedir(), ".codex");
  return path.resolve(expanded);
}

export const resolveCodexHomeLayout = Effect.fn("resolveCodexHomeLayout")(function* (
  config: CodexSettings,
): Effect.fn.Return<CodexHomeLayout, never, Path.Path> {
  const path = yield* Path.Path;
  const sharedHomePath = resolveHomePath(path, config.homePath);
  const shadowHomePath = config.shadowHomePath.trim();
  if (shadowHomePath.length === 0) {
    return {
      mode: "direct",
      sharedHomePath,
      effectiveHomePath: config.homePath.trim().length > 0 ? sharedHomePath : undefined,
      continuationKey: `codex:home:${sharedHomePath}`,
    };
  }

  const effectiveHomePath = path.resolve(expandHomePath(shadowHomePath));
  return {
    mode: "authOverlay",
    sharedHomePath,
    effectiveHomePath,
    continuationKey: `codex:home:${sharedHomePath}`,
  };
});

const CodexShadowHomeContext = {
  sharedHomePath: Schema.String,
  effectiveHomePath: Schema.String,
};

export class CodexShadowHomeFileSystemError extends Schema.TaggedError<CodexShadowHomeFileSystemError>()(
  "CodexShadowHomeFileSystemError",
  {
    ...CodexShadowHomeContext,
    operation: Schema.Literals([
      "readLink",
      "makeDirectory",
      "readDirectory",
      "remove",
      "symlink",
      "readFile",
      "writeFile",
    ]),
    path: Schema.String,
    targetPath: Schema.optional(Schema.String),
    entryName: Schema.optional(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    const target = this.targetPath === undefined ? "" : ` to '${this.targetPath}'`;
    return `Codex shadow home filesystem operation '${this.operation}' failed for '${this.path}'${target}.`;
  }
}

export class CodexShadowHomePathConflictError extends Schema.TaggedError<CodexShadowHomePathConflictError>()(
  "CodexShadowHomePathConflictError",
  CodexShadowHomeContext,
) {
  override get message(): string {
    return `Codex shadow home path '${this.effectiveHomePath}' must be different from the shared home path '${this.sharedHomePath}'.`;
  }
}

export class CodexShadowHomeEntryConflictError extends Schema.TaggedError<CodexShadowHomeEntryConflictError>()(
  "CodexShadowHomeEntryConflictError",
  {
    ...CodexShadowHomeContext,
    entryName: Schema.String,
    linkPath: Schema.String,
    targetPath: Schema.String,
  },
) {
  override get message(): string {
    return `Cannot create Codex shadow home entry '${this.entryName}' because '${this.linkPath}' already exists and is not a symlink.`;
  }
}

export class CodexShadowHomePrivateEntrySymlinkError extends Schema.TaggedError<CodexShadowHomePrivateEntrySymlinkError>()(
  "CodexShadowHomePrivateEntrySymlinkError",
  {
    ...CodexShadowHomeContext,
    entryName: Schema.String,
    path: Schema.String,
  },
) {
  override get message(): string {
    return `Codex shadow home private entry '${this.entryName}' at '${this.path}' must be a real file, not a symlink.`;
  }
}

export const CodexShadowHomeError = Schema.Union([
  CodexShadowHomeFileSystemError,
  CodexShadowHomePathConflictError,
  CodexShadowHomeEntryConflictError,
  CodexShadowHomePrivateEntrySymlinkError,
]);
export type CodexShadowHomeError = typeof CodexShadowHomeError.Type;

type LinkState =
  | {
      readonly _tag: "Missing";
    }
  | {
      readonly _tag: "NotSymlink";
    }
  | {
      readonly _tag: "Symlink";
      readonly target: string;
    };

function isNotSymlinkError(error: PlatformError.PlatformError): boolean {
  const cause = error.reason.cause;
  return (
    error.reason._tag === "Unknown" &&
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    cause.code === "EINVAL"
  );
}

const readLinkState = Effect.fn("CodexHomeLayout.readLinkState")(function* (input: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly sharedHomePath: string;
  readonly effectiveHomePath: string;
  readonly entryName: string;
  readonly linkPath: string;
}): Effect.fn.Return<LinkState, CodexShadowHomeError> {
  return yield* input.fileSystem.readLink(input.linkPath).pipe(
    Effect.map((target): LinkState => ({ _tag: "Symlink", target })),
    Effect.catchTags({
      PlatformError: (cause) => {
        if (cause.reason._tag === "NotFound") {
          return Effect.succeed<LinkState>({ _tag: "Missing" });
        }
        if (isNotSymlinkError(cause)) {
          return Effect.succeed<LinkState>({ _tag: "NotSymlink" });
        }
        return new CodexShadowHomeFileSystemError({
          sharedHomePath: input.sharedHomePath,
          effectiveHomePath: input.effectiveHomePath,
          operation: "readLink",
          path: input.linkPath,
          entryName: input.entryName,
          cause,
        });
      },
    }),
  );
});

const removePrivateSymlink = Effect.fn("CodexHomeLayout.removePrivateSymlink")(function* (input: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly sharedHomePath: string;
  readonly effectiveHomePath: string;
  readonly entryName: string;
}): Effect.fn.Return<void, CodexShadowHomeError, Path.Path> {
  const path = yield* Path.Path;
  const privatePath = path.join(input.effectiveHomePath, input.entryName);
  const state = yield* readLinkState({
    ...input,
    linkPath: privatePath,
  });
  if (state._tag === "Symlink") {
    yield* input.fileSystem.remove(privatePath).pipe(
      Effect.catchTags({
        PlatformError: (cause) =>
          new CodexShadowHomeFileSystemError({
            sharedHomePath: input.sharedHomePath,
            effectiveHomePath: input.effectiveHomePath,
            operation: "remove",
            path: privatePath,
            entryName: input.entryName,
            cause,
          }),
      }),
    );
  }
});

const ensureSymlink = Effect.fn("CodexHomeLayout.ensureSymlink")(function* (input: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly sharedHomePath: string;
  readonly effectiveHomePath: string;
  readonly entryName: string;
}): Effect.fn.Return<void, CodexShadowHomeError, Path.Path> {
  const path = yield* Path.Path;
  const target = path.join(input.sharedHomePath, input.entryName);
  const link = path.join(input.effectiveHomePath, input.entryName);
  const state = yield* readLinkState({
    ...input,
    linkPath: link,
  });

  const createLink = input.fileSystem.symlink(target, link).pipe(
    Effect.catchTags({
      PlatformError: (cause) =>
        new CodexShadowHomeFileSystemError({
          sharedHomePath: input.sharedHomePath,
          effectiveHomePath: input.effectiveHomePath,
          operation: "symlink",
          path: link,
          targetPath: target,
          entryName: input.entryName,
          cause,
        }),
    }),
  );

  if (state._tag === "NotSymlink") {
    if (!REPLACEABLE_SHARED_RUNTIME_DIRECTORIES.has(input.entryName)) {
      return yield* new CodexShadowHomeEntryConflictError({
        sharedHomePath: input.sharedHomePath,
        effectiveHomePath: input.effectiveHomePath,
        entryName: input.entryName,
        linkPath: link,
        targetPath: target,
      });
    }

    yield* input.fileSystem.remove(link, { recursive: true }).pipe(
      Effect.catchTags({
        PlatformError: (cause) =>
          new CodexShadowHomeFileSystemError({
            sharedHomePath: input.sharedHomePath,
            effectiveHomePath: input.effectiveHomePath,
            operation: "remove",
            path: link,
            entryName: input.entryName,
            cause,
          }),
      }),
    );
    return yield* createLink;
  }

  if (state._tag === "Missing") {
    return yield* createLink;
  }

  const resolvedExisting = path.resolve(path.dirname(link), state.target);
  if (resolvedExisting !== target) {
    yield* input.fileSystem.remove(link).pipe(
      Effect.catchTags({
        PlatformError: (cause) =>
          new CodexShadowHomeFileSystemError({
            sharedHomePath: input.sharedHomePath,
            effectiveHomePath: input.effectiveHomePath,
            operation: "remove",
            path: link,
            entryName: input.entryName,
            cause,
          }),
      }),
    );
    yield* createLink;
  }
});

const ensureShadowAuthIsPrivate = Effect.fn("CodexHomeLayout.ensureShadowAuthIsPrivate")(
  function* (input: {
    readonly fileSystem: FileSystem.FileSystem;
    readonly sharedHomePath: string;
    readonly effectiveHomePath: string;
  }): Effect.fn.Return<void, CodexShadowHomeError, Path.Path> {
    const path = yield* Path.Path;
    const entryName = "auth.json";
    const authPath = path.join(input.effectiveHomePath, entryName);
    const state = yield* readLinkState({
      ...input,
      entryName,
      linkPath: authPath,
    });
    if (state._tag === "Symlink") {
      return yield* new CodexShadowHomePrivateEntrySymlinkError({
        sharedHomePath: input.sharedHomePath,
        effectiveHomePath: input.effectiveHomePath,
        entryName,
        path: authPath,
      });
    }
  },
);

/**
 * Drop a config.toml that a previous backend wiring left as a T3-owned real
 * file in the shadow home so `ensureSymlink` can restore the shared link.
 * Files without the marker belong to the user and are left alone.
 */
const removeGeneratedBackendConfigToml = Effect.fn(
  "CodexHomeLayout.removeGeneratedBackendConfigToml",
)(function* (input: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly sharedHomePath: string;
  readonly effectiveHomePath: string;
}): Effect.fn.Return<void, CodexShadowHomeError, Path.Path> {
  const path = yield* Path.Path;
  const linkPath = path.join(input.effectiveHomePath, "config.toml");
  const state = yield* readLinkState({
    fileSystem: input.fileSystem,
    sharedHomePath: input.sharedHomePath,
    effectiveHomePath: input.effectiveHomePath,
    entryName: "config.toml",
    linkPath,
  });
  if (state._tag !== "NotSymlink") return;
  const contents = yield* input.fileSystem.readFileString(linkPath).pipe(Effect.option);
  if (Option.isSome(contents) && contents.value.startsWith(CODEX_BACKEND_CONFIG_MARKER)) {
    yield* input.fileSystem.remove(linkPath).pipe(
      Effect.catchTags({
        PlatformError: (cause) =>
          new CodexShadowHomeFileSystemError({
            sharedHomePath: input.sharedHomePath,
            effectiveHomePath: input.effectiveHomePath,
            operation: "remove",
            path: linkPath,
            entryName: "config.toml",
            cause,
          }),
      }),
    );
  }
});

export const materializeCodexShadowHome = Effect.fn("materializeCodexShadowHome")(function* (
  layout: CodexHomeLayout,
  options?: { readonly privateConfigToml?: boolean },
) {
  if (layout.mode !== "authOverlay") return;
  const effectiveHomePath = layout.effectiveHomePath;
  if (!effectiveHomePath) return;
  if (layout.sharedHomePath === effectiveHomePath) {
    return yield* new CodexShadowHomePathConflictError({
      sharedHomePath: layout.sharedHomePath,
      effectiveHomePath,
    });
  }

  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  // When a backend is wired, the shadow home keeps a private (real-file)
  // config.toml generated by `writeCodexBackendShadowConfig` instead of the
  // shared symlink; without a backend, a leftover generated file is removed so
  // the shared symlink is restored.
  const privateConfigToml = options?.privateConfigToml === true;
  if (privateConfigToml) {
    yield* removePrivateSymlink({
      fileSystem,
      sharedHomePath: layout.sharedHomePath,
      effectiveHomePath,
      entryName: "config.toml",
    });
  } else {
    yield* removeGeneratedBackendConfigToml({
      fileSystem,
      sharedHomePath: layout.sharedHomePath,
      effectiveHomePath,
    });
  }

  const makeDirectory = (directoryPath: string) =>
    fileSystem.makeDirectory(directoryPath, { recursive: true }).pipe(
      Effect.catchTags({
        PlatformError: (cause) =>
          new CodexShadowHomeFileSystemError({
            sharedHomePath: layout.sharedHomePath,
            effectiveHomePath,
            operation: "makeDirectory",
            path: directoryPath,
            cause,
          }),
      }),
    );

  yield* Effect.all(
    [
      makeDirectory(layout.sharedHomePath),
      makeDirectory(effectiveHomePath),
      ...KNOWN_SHARED_DIRECTORIES.map((directory) =>
        makeDirectory(path.join(layout.sharedHomePath, directory)),
      ),
    ],
    { concurrency: "unbounded" },
  );

  const sharedEntryNames = yield* fileSystem.readDirectory(layout.sharedHomePath).pipe(
    Effect.catchTags({
      PlatformError: (cause) =>
        new CodexShadowHomeFileSystemError({
          sharedHomePath: layout.sharedHomePath,
          effectiveHomePath,
          operation: "readDirectory",
          path: layout.sharedHomePath,
          cause,
        }),
    }),
  );
  const entries = new Set<string>(KNOWN_SHARED_DIRECTORIES);
  for (const entryName of sharedEntryNames) {
    if (!PRIVATE_ENTRY_NAMES.has(entryName) && !SHADOW_LOCAL_ENTRY_NAMES.has(entryName)) {
      entries.add(entryName);
    }
  }

  yield* Effect.forEach(
    PRIVATE_ENTRY_NAMES,
    (entryName) =>
      entryName === "auth.json"
        ? Effect.void
        : removePrivateSymlink({
            fileSystem,
            sharedHomePath: layout.sharedHomePath,
            effectiveHomePath,
            entryName,
          }),
    { discard: true },
  );

  yield* Effect.forEach(
    entries,
    (entryName) => {
      if (PRIVATE_ENTRY_NAMES.has(entryName)) {
        return Effect.void;
      }
      if (entryName === "config.toml" && privateConfigToml) {
        return Effect.void;
      }
      return ensureSymlink({
        fileSystem,
        sharedHomePath: layout.sharedHomePath,
        effectiveHomePath,
        entryName,
      });
    },
    { discard: true },
  );

  yield* ensureShadowAuthIsPrivate({
    fileSystem,
    sharedHomePath: layout.sharedHomePath,
    effectiveHomePath,
  });
});

/**
 * Whether a model backend is wired into a shadow home's config.toml at all.
 * Codex speaks the OpenAI wire protocol only, so an endpoint that does not
 * declare it (or has no base URL to point at) leaves the instance exactly as
 * an unconfigured one.
 */
export function codexBackendWiresProvider(
  backend: ModelBackendConfig | undefined,
): backend is ModelBackendConfig & {
  readonly kind: "openai-compatible";
  readonly baseUrl: string;
} {
  return (
    backend !== undefined &&
    backend.kind !== "native" &&
    (backend.protocols ?? DEFAULT_BACKEND_PROTOCOLS).includes("openai") &&
    typeof backend.baseUrl === "string" &&
    backend.baseUrl.length > 0
  );
}

export const CODEX_BACKEND_PROVIDER_ID = "t3_backend";
const CODEX_BACKEND_SECTION_HEADER = `[model_providers.${CODEX_BACKEND_PROVIDER_ID}]`;

/**
 * Marks the shadow home's generated config.toml as T3-owned so the reverse
 * transition (backend removed) can drop the private file and restore the
 * shared home's symlink.
 */
export const CODEX_BACKEND_CONFIG_MARKER =
  "# Generated by T3 Code model routing; edit the shared CODEX_HOME config.toml instead.\n";

const tomlEscapeString = (value: string): string =>
  `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;

const isTomlSectionHeader = (line: string): boolean => /^\[.*\]$/.test(line.trim());

function renderBackendProviderSection(input: {
  readonly baseUrl: string;
  readonly envKey?: string | undefined;
  readonly useOpenaiAuth?: boolean | undefined;
}): Array<string> {
  const lines = [
    CODEX_BACKEND_SECTION_HEADER,
    `base_url = ${tomlEscapeString(input.baseUrl)}`,
    // "chat" (Chat Completions) is what OpenAI-compatible vendor endpoints
    // speak; Codex's native "responses" wire is not something they serve.
    'wire_api = "chat"',
  ];
  if (input.useOpenaiAuth === true) {
    // OAuth account backend: Codex's own sign-in authenticates the proxied
    // requests, so the section must not carry an `env_key`.
    lines.push("requires_openai_auth = true");
  }
  if (input.envKey !== undefined) {
    lines.push(`env_key = ${tomlEscapeString(input.envKey)}`);
  }
  return lines;
}

/**
 * Merge the T3 backend provider into a Codex config.toml. Merge rule: the
 * user's file is preserved line-for-line except two T3-owned spans — the
 * top-level `model_provider` selection key and the
 * `[model_providers.t3_backend]` section — which are replaced in place when
 * present (the id is reserved by T3) and appended otherwise. A hand-written
 * inline `t3_backend = { … }` entry under `[model_providers]` is dropped so
 * the generated section cannot produce a duplicate-key TOML error.
 */
export function mergeCodexBackendConfigToml(
  userToml: string | undefined,
  input: {
    readonly baseUrl: string;
    readonly envKey?: string | undefined;
    /** Emit `requires_openai_auth = true` (Codex's own OAuth login authenticates). */
    readonly useOpenaiAuth?: boolean | undefined;
  },
): string {
  const lines = (userToml ?? "").split(/\r?\n/);

  // 1. Top-level `model_provider` selection: replaced inside the top-level
  //    table (before the first section header), inserted there when absent.
  const firstHeaderIndex = lines.findIndex((line) => isTomlSectionHeader(line));
  const topLevelEnd = firstHeaderIndex === -1 ? lines.length : firstHeaderIndex;
  const selectionLine = `model_provider = ${tomlEscapeString(CODEX_BACKEND_PROVIDER_ID)}`;
  const selectionIndex = lines
    .slice(0, topLevelEnd)
    .findIndex((line) => /^model_provider\s*=/.test(line.trim()));
  if (selectionIndex !== -1) {
    lines[selectionIndex] = selectionLine;
  } else {
    const needsSeparator = topLevelEnd > 0 && (lines[topLevelEnd - 1]?.trim().length ?? 0) > 0;
    lines.splice(topLevelEnd, 0, ...(needsSeparator ? ["", selectionLine] : [selectionLine]));
  }

  // 2. The [model_providers.t3_backend] section: body replaced under the
  //    existing header, otherwise appended as a new section at the end.
  const sectionLines = renderBackendProviderSection(input);
  const existingSectionIndex = lines.findIndex(
    (line) => line.trim() === CODEX_BACKEND_SECTION_HEADER,
  );
  if (existingSectionIndex !== -1) {
    let endIndex = existingSectionIndex + 1;
    while (endIndex < lines.length && !isTomlSectionHeader(lines[endIndex] ?? "")) {
      endIndex += 1;
    }
    lines.splice(existingSectionIndex, endIndex - existingSectionIndex, ...sectionLines);
  } else {
    // Drop an inline definition of the reserved id inside [model_providers].
    const providersTableIndex = lines.findIndex(
      (line) => line.trim() === "[model_providers]" || line.trim() === "[[model_providers]]",
    );
    if (providersTableIndex !== -1) {
      let endIndex = providersTableIndex + 1;
      while (endIndex < lines.length && !isTomlSectionHeader(lines[endIndex] ?? "")) {
        endIndex += 1;
      }
      for (let index = providersTableIndex + 1; index < endIndex; index++) {
        if (/^\s*t3_backend\s*=/.test(lines[index] ?? "")) {
          lines.splice(index, 1);
          break;
        }
      }
    }
    if (lines.length > 0 && (lines[lines.length - 1]?.trim().length ?? 0) > 0) {
      lines.push("");
    }
    lines.push(...sectionLines);
  }

  return lines.join("\n");
}

/**
 * Write the model backend's `model_providers` entry into the shadow home's
 * config.toml, selecting it via the top-level `model_provider` key — the file
 * every codex invocation of this CODEX_HOME reads (session app-server, status
 * and skills probes, `codex exec`), so no launch-args threading is needed.
 * The API key value never enters the TOML: only `env_key` names the variable,
 * the key itself travels through the env overlay the driver merges.
 *
 * Only an authOverlay shadow home can host a T3-owned config.toml — in direct
 * mode the config file is the user's own CODEX_HOME and is never modified.
 * The merge base is the shadow home's own file when one exists (never clobber
 * user content), otherwise the shared home's config.toml, which stays
 * untouched. While a backend is attached the shadow copy is T3-owned, so
 * edits to the shared file apply again once the backend is removed.
 */
export const writeCodexBackendShadowConfig = Effect.fn("writeCodexBackendShadowConfig")(function* (
  layout: CodexHomeLayout,
  backend: ModelBackendConfig | undefined,
  backendEnv: NodeJS.ProcessEnv,
): Effect.fn.Return<void, CodexShadowHomeError, FileSystem.FileSystem | Path.Path> {
  if (!codexBackendWiresProvider(backend) || layout.mode !== "authOverlay") return;
  const effectiveHomePath = layout.effectiveHomePath;
  if (effectiveHomePath === undefined) return;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const sharedConfigPath = path.join(layout.sharedHomePath, "config.toml");
  const shadowConfigPath = path.join(effectiveHomePath, "config.toml");

  const readTomlIfExists = (filePath: string) =>
    fileSystem.readFileString(filePath).pipe(
      Effect.catchTags({
        PlatformError: (cause: PlatformError.PlatformError) =>
          cause.reason._tag === "NotFound"
            ? Effect.succeed<string | undefined>(undefined)
            : Effect.fail(
                new CodexShadowHomeFileSystemError({
                  sharedHomePath: layout.sharedHomePath,
                  effectiveHomePath,
                  operation: "readFile",
                  path: filePath,
                  cause,
                }),
              ),
      }),
    );

  const shadowExisting = yield* readTomlIfExists(shadowConfigPath);
  const baseToml =
    shadowExisting !== undefined
      ? shadowExisting.startsWith(CODEX_BACKEND_CONFIG_MARKER)
        ? shadowExisting.slice(CODEX_BACKEND_CONFIG_MARKER.length)
        : shadowExisting
      : yield* readTomlIfExists(sharedConfigPath);

  const merged = mergeCodexBackendConfigToml(baseToml, {
    baseUrl: backend.baseUrl,
    // The overlay carries OPENAI_API_KEY only when a key actually resolved.
    // An OAuth account backend ignores it entirely: Codex's own sign-in
    // authenticates, and `requires_openai_auth` makes Codex ignore `env_key`.
    envKey:
      backend.codexAccountInstanceId === undefined &&
      backendEnv.OPENAI_API_KEY !== undefined &&
      backendEnv.OPENAI_API_KEY.length > 0
        ? "OPENAI_API_KEY"
        : undefined,
    ...(backend.codexAccountInstanceId !== undefined ? { useOpenaiAuth: true } : {}),
  });

  yield* fileSystem.writeFileString(shadowConfigPath, CODEX_BACKEND_CONFIG_MARKER + merged).pipe(
    Effect.catchTags({
      PlatformError: (cause: PlatformError.PlatformError) =>
        new CodexShadowHomeFileSystemError({
          sharedHomePath: layout.sharedHomePath,
          effectiveHomePath,
          operation: "writeFile",
          path: shadowConfigPath,
          cause,
        }),
    }),
  );
});

export function codexContinuationIdentity(layout: CodexHomeLayout) {
  return {
    driverKind: ProviderDriverKind.make("codex"),
    continuationKey: layout.continuationKey,
  };
}
