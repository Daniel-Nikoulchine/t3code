import { MODEL_CREDENTIAL_VALUE_REDACTED, type ModelCredential } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  addCredential,
  allocateCredentialId,
  buildInstanceConnections,
  countCredentialReferences,
  credentialProbeUrl,
  credentialSecretState,
  credentialVendorLabel,
  isPresetVendor,
  nextCredentialWithSecret,
  referencingConnection,
  removeCredential,
  slugifyCredentialId,
  validateCredentialId,
  validateVendorSlug,
} from "./providerCredentials.logic";

const stored: ModelCredential = {
  displayName: "Anthropic work key",
  vendor: "anthropic" as ModelCredential["vendor"],
  value: MODEL_CREDENTIAL_VALUE_REDACTED,
  lastFour: "ab12",
};
const empty: ModelCredential = {
  displayName: "Spare",
  vendor: "openai",
  value: "",
} as ModelCredential;

describe("credentialSecretState", () => {
  it("reads the sentinel as a stored secret with its last four", () => {
    expect(credentialSecretState(stored)).toEqual({ kind: "stored", lastFour: "ab12" });
  });

  it("reads an empty value as no stored key", () => {
    expect(credentialSecretState(empty)).toEqual({ kind: "empty" });
  });
});

describe("credentialVendorLabel / isPresetVendor / credentialProbeUrl", () => {
  it("labels the presets and passes custom slugs through", () => {
    expect(credentialVendorLabel("anthropic")).toBe("Anthropic");
    expect(credentialVendorLabel("google")).toBe("Google Gemini");
    expect(credentialVendorLabel("glm")).toBe("glm");
  });

  it("gives every preset a probe URL and custom vendors none", () => {
    for (const vendor of ["anthropic", "openai", "google", "deepseek", "xai"]) {
      expect(isPresetVendor(vendor)).toBe(true);
      expect(credentialProbeUrl(vendor)).toMatch(/^https:\/\//u);
    }
    expect(isPresetVendor("glm")).toBe(false);
    expect(credentialProbeUrl("glm")).toBeUndefined();
  });
});

describe("slugifyCredentialId / allocateCredentialId / validateCredentialId", () => {
  it("slugifies labels with the key fallback", () => {
    expect(slugifyCredentialId("Anthropic work key")).toBe("anthropic-work-key");
    expect(slugifyCredentialId("9lives")).toBe("key-9lives");
    expect(slugifyCredentialId("   ")).toBe("key");
  });

  it("allocates free ids and suffixes collisions", () => {
    expect(allocateCredentialId("anthropic-work", new Set(["other"]))).toBe("anthropic-work");
    expect(allocateCredentialId("key", new Set(["key"]))).toBe("key-2");
  });

  it("rejects empty, overlong, and off-pattern ids", () => {
    expect(validateCredentialId("   ")).toContain("required");
    expect(validateCredentialId("1bad")).toContain("must start with a letter");
    expect(validateCredentialId("a".repeat(65))).toContain("64");
  });
});

describe("validateVendorSlug", () => {
  it("accepts preset-shaped slugs and rejects blanks", () => {
    expect(validateVendorSlug("glm")).toBeNull();
    expect(validateVendorSlug("")).toContain("required");
    expect(validateVendorSlug("has space")).toContain("must start with a letter");
  });
});

describe("addCredential / removeCredential", () => {
  it("adds and removes one entry, leaving the others alone", () => {
    const withOne = addCredential({}, "key-a", empty);
    expect(Object.keys(withOne)).toEqual(["key-a"]);
    const withTwo = addCredential(withOne, "key-b", stored);
    expect(Object.keys(removeCredential(withTwo, "key-a"))).toEqual(["key-b"]);
  });
});

describe("nextCredentialWithSecret", () => {
  it("keeps the stored sentinel and lastFour when the key input stays blank", () => {
    const next = nextCredentialWithSecret(stored, {
      displayName: "Renamed key",
      vendor: "anthropic",
      value: "",
    });
    expect(next).toEqual({ ...stored, displayName: "Renamed key" });
  });

  it("replaces the secret and drops stale lastFour when a new key is typed", () => {
    const next = nextCredentialWithSecret(stored, {
      displayName: "Anthropic work key",
      vendor: "anthropic",
      value: "  sk-new  ",
    });
    expect(next).toEqual({
      displayName: "Anthropic work key",
      vendor: "anthropic",
      value: "sk-new",
    });
  });
});

describe("countCredentialReferences / referencingConnection", () => {
  // Branded key/property types cannot be written as plain literals in tests;
  // the fixtures assert through casts like `providerBackend.logic.test.ts`.
  const connections = {
    a: { baseUrl: "https://a.example/v1", apiKeyCredentialId: "key-a" },
    b: { baseUrl: "https://b.example/v1", apiKeyCredentialId: "key-a", apiKeyEnv: "FALLBACK_KEY" },
    c: { baseUrl: "https://c.example/v1" },
  } as unknown as Parameters<typeof countCredentialReferences>[0] &
    Parameters<typeof referencingConnection>[0];

  it("counts connections referencing the credential", () => {
    expect(countCredentialReferences(connections, "key-a")).toBe(2);
    expect(countCredentialReferences(connections, "key-z")).toBe(0);
  });

  it("returns the first referencing connection for the custom-vendor test", () => {
    expect(referencingConnection(connections, "key-a")).toEqual({
      id: "a",
      baseUrl: "https://a.example/v1",
    });
    expect(referencingConnection(connections, "key-b")).toBeUndefined();
  });
});

describe("buildInstanceConnections", () => {
  it("mirrors instanceId to connectionId, skipping direct instances", () => {
    const instances = {
      codex: { driver: "codex", connectionId: "main-proxy" },
      claude: { driver: "claudeAgent" },
    } as unknown as Parameters<typeof buildInstanceConnections>[0];
    expect(buildInstanceConnections(instances)).toEqual({ codex: "main-proxy" });
    expect(buildInstanceConnections(undefined)).toEqual({});
  });
});
