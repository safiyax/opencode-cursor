import { describe, expect, test, spyOn } from "bun:test";
import { logPluginInfo, logPluginWarn } from "../src/logger";

describe("logger fallback", () => {
  test("does not write info logs to console when structured logging is unavailable", () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});

    logPluginInfo("Handling Cursor chat completion request", { modelId: "test" });

    expect(warnSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();

    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  test("still writes warn logs to console when structured logging is unavailable", () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});

    logPluginWarn("Rejected Cursor chat completion", { status: 400 });

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toContain("[opencode-cursor-oauth]");
    expect(warnSpy.mock.calls[0]?.[0]).toContain("Rejected Cursor chat completion");

    warnSpy.mockRestore();
  });
});
