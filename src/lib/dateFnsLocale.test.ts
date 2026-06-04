import { describe, it, expect } from "vitest";
import {
  DAY_PICKER_WEEK_STARTS_ON,
  getDateFnsLocale,
  getDayPickerLocale,
} from "./dateFnsLocale";
import { enGB, enUS, nl } from "date-fns/locale";

describe("getDayPickerLocale", () => {
  it("uses Monday week start for English via en-GB", () => {
    const locale = getDayPickerLocale("en");
    expect(locale.code).toBe("en-GB");
    expect(locale.options?.weekStartsOn).toBe(1);
  });

  it("uses Monday week start for Dutch", () => {
    const locale = getDayPickerLocale("nl");
    expect(locale.code).toBe("nl");
    expect(locale.options?.weekStartsOn).toBe(1);
  });

  it("defaults unknown languages to en-GB (Monday)", () => {
    expect(getDayPickerLocale("xx").code).toBe("en-GB");
  });

  it("exports ISO week start constant", () => {
    expect(DAY_PICKER_WEEK_STARTS_ON).toBe(1);
  });
});

describe("getDateFnsLocale", () => {
  it("still uses en-US for general date formatting", () => {
    expect(getDateFnsLocale("en")).toBe(enUS);
    expect(getDateFnsLocale("nl")).toBe(nl);
  });

  it("day picker and display locales differ for English by design", () => {
    expect(getDayPickerLocale("en")).toBe(enGB);
    expect(getDateFnsLocale("en")).toBe(enUS);
  });
});
