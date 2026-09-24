import { DEFAULT_UNIFIED_SETTINGS, EnvironmentId, type ServerSettings } from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { visitElements } from "../../test/reactElementTree";
import { reactHookHarness as hooks } from "../../test/reactHookHarness";

const settingsHooks = vi.hoisted(() => ({
  read: vi.fn(
    (): {
      providers?: Partial<ServerSettings["providers"]>;
      providerInstances: ServerSettings["providerInstances"];
    } => ({ providerInstances: {} }),
  ),
  save: vi.fn(),
  update: vi.fn(() => vi.fn()),
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return {
    ...actual,
    useMemo: reactHookHarness.useMemo,
    useState: reactHookHarness.useState,
  };
});

vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});

vi.mock("../../hooks/useSettings", () => ({
  useEnvironmentSettings: settingsHooks.read,
  useUpdateEnvironmentSettings: settingsHooks.update,
}));

import { AddProviderInstanceDialog } from "./AddProviderInstanceDialog";

const remoteEnvironmentId = EnvironmentId.make("remote-device");

describe("AddProviderInstanceDialog environment routing", () => {
  beforeEach(() => {
    hooks.reset();
    settingsHooks.read.mockReset().mockReturnValue({ providerInstances: {} });
    settingsHooks.save.mockReset();
    settingsHooks.update.mockReset().mockReturnValue(settingsHooks.save);
  });

  it("rejects saving if the Harness was added while the dialog was open", () => {
    const render = () => {
      hooks.beginRender();
      return AddProviderInstanceDialog({
        open: true,
        environmentId: remoteEnvironmentId,
        environmentLabel: "Remote device",
        onOpenChange: vi.fn(),
      });
    };
    const changeLabel = visitElements(
      render(),
      (element) => element.props.placeholder === "e.g. Work",
    )?.props.onChange;
    if (typeof changeLabel !== "function") throw new Error("Label input missing");
    changeLabel({ target: { value: "Work" } });
    for (let step = 0; step < 2; step++) {
      const next = visitElements(render(), (element) => element.props.children === "Next")?.props
        .onClick;
      if (typeof next !== "function") throw new Error("Next button missing");
      next();
    }
    settingsHooks.read.mockReturnValue(DEFAULT_UNIFIED_SETTINGS);
    const save = visitElements(render(), (element) => element.props.children === "Add instance")
      ?.props.onClick;
    if (typeof save !== "function") throw new Error("Save button missing");
    save();
    expect(settingsHooks.save).not.toHaveBeenCalled();
  });

  it("reads and writes settings through the supplied environment", () => {
    hooks.beginRender();
    AddProviderInstanceDialog({
      open: true,
      environmentId: remoteEnvironmentId,
      environmentLabel: "Remote device",
      onOpenChange: vi.fn(),
    });

    expect(settingsHooks.read).toHaveBeenCalledWith(remoteEnvironmentId);
    expect(settingsHooks.update).toHaveBeenCalledWith(remoteEnvironmentId);
  });
});
