import { describe, it, expect } from "vitest";
import enCommon from "@/i18n/locales/en/common.json";

describe("AcademyCycleDetail not-found i18n", () => {
  it("uses string keys for notFound title and description, not the parent object", () => {
    const notFound = enCommon.notFound as Record<string, unknown>;
    expect(typeof notFound.title).toBe("string");
    expect(typeof notFound.description).toBe("string");
    expect(typeof enCommon.notFound).toBe("object");
    expect(typeof (enCommon.notFound as { title?: string }).title).toBe("string");
  });
});
