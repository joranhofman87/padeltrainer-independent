import { describe, it, expect, beforeAll } from "vitest";
import { render, screen } from "@testing-library/react";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { I18nextProvider } from "react-i18next";
import { Calendar } from "./calendar";

const testI18n = i18n.createInstance();

beforeAll(async () => {
  await testI18n.use(initReactI18next).init({
    lng: "en",
    fallbackLng: "en",
    resources: { en: { translation: {} } },
    interpolation: { escapeValue: false },
  });
});

function renderCalendar(language = "en") {
  void testI18n.changeLanguage(language);
  return render(
    <I18nextProvider i18n={testI18n}>
      <Calendar defaultMonth={new Date(2025, 0, 1)} />
    </I18nextProvider>,
  );
}

describe("Calendar (DayPicker)", () => {
  it("renders weekday headers starting with Monday in English", () => {
    const { container } = renderCalendar("en");
    const headers = Array.from(
      container.querySelectorAll("thead th, .rdp-head_cell"),
    ).map((el) => el.textContent?.trim() ?? "");

    expect(headers.length).toBeGreaterThanOrEqual(7);
    expect(headers[0]?.toLowerCase()).toMatch(/^mo/);
    expect(headers[6]?.toLowerCase()).toMatch(/^su/);
  });

  it("renders localized Dutch weekday headers starting with Monday", async () => {
    const { container } = renderCalendar("nl");
    const headers = Array.from(
      container.querySelectorAll("thead th, .rdp-head_cell"),
    ).map((el) => el.textContent?.trim() ?? "");

    expect(headers[0]?.toLowerCase()).toMatch(/^ma/);
    expect(headers[6]?.toLowerCase()).toMatch(/^zo/);
  });

  it("shows month caption for navigation", () => {
    renderCalendar("en");
    expect(screen.getByText("January 2025")).toBeInTheDocument();
  });
});
