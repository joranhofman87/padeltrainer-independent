import { describe, it, expect, vi } from "vitest";
import { screen, fireEvent } from "@testing-library/react";
import { renderWithI18n } from "@/test/renderWithI18n";
import { DatePickerPopover } from "./date-picker-popover";

describe("DatePickerPopover", () => {
  it("shows the placeholder when no date is selected", () => {
    renderWithI18n(
      <DatePickerPopover value={undefined} onChange={() => {}} placeholder="Pick a date" />,
    );
    expect(screen.getByRole("button", { name: /pick a date/i })).toBeInTheDocument();
  });

  it("shows the selected date in the canonical locale-aware format (d MMM yyyy)", () => {
    renderWithI18n(
      <DatePickerPopover value={new Date(2026, 3, 5)} onChange={() => {}} />,
    );
    // Not "PPP" (April 5th, 2026) and not a native yyyy-mm-dd — the standardized short label.
    expect(screen.getByRole("button", { name: /5 Apr 2026/ })).toBeInTheDocument();
  });

  it("honors an explicit displayFormat override", () => {
    renderWithI18n(
      <DatePickerPopover value={new Date(2026, 3, 5)} onChange={() => {}} displayFormat="yyyy-MM-dd" />,
    );
    expect(screen.getByRole("button", { name: /2026-04-05/ })).toBeInTheDocument();
  });

  it("renders a non-submitting trigger button (type=button) so it is safe inside forms", () => {
    renderWithI18n(<DatePickerPopover value={undefined} onChange={() => {}} placeholder="Pick a date" />);
    expect(screen.getByRole("button")).toHaveAttribute("type", "button");
  });

  it("opens the calendar and reports the picked day via onChange (Date in / Date out)", async () => {
    const onChange = vi.fn();
    renderWithI18n(
      <DatePickerPopover value={new Date(2026, 3, 5)} onChange={onChange} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /5 Apr 2026/ }));
    const grid = await screen.findByRole("grid");
    expect(grid).toBeInTheDocument();
    // Pick day 10 of the shown month (react-day-picker renders the day as the gridcell button).
    fireEvent.click(screen.getByRole("gridcell", { name: "10" }));
    expect(onChange).toHaveBeenCalledTimes(1);
    const picked = onChange.mock.calls[0][0] as Date;
    expect(picked).toBeInstanceOf(Date);
    expect(picked.getDate()).toBe(10);
  });
});
