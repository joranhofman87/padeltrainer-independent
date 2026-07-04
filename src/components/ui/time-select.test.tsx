import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { TimeSelect } from "./time-select";

// The repo convention is not to drive Radix Select's portal in jsdom (no
// pointer-capture polyfills, no existing test opens one). The option-list
// contract is pinned in `lib/timeOptions.test.ts`; here we cover the trigger
// surface the migrated call-sites rely on (label, value, disabled, classes).
describe("TimeSelect", () => {
  it("renders a labelled combobox trigger showing the selected time", () => {
    render(<TimeSelect value="09:00" onValueChange={() => {}} ariaLabel="Start time" />);
    const trigger = screen.getByRole("combobox", { name: "Start time" });
    expect(trigger).toBeInTheDocument();
    expect(trigger).toHaveTextContent("09:00");
  });

  it("renders a legacy OFF-GRID value in the trigger instead of a blank (splices it into the options)", () => {
    // Sites migrated from free-entry <input type="time"> can hold e.g. "09:15".
    render(<TimeSelect value="09:15" onValueChange={() => {}} ariaLabel="Start time" />);
    expect(screen.getByRole("combobox", { name: "Start time" })).toHaveTextContent("09:15");
  });

  it("can be disabled", () => {
    render(
      <TimeSelect value="09:00" onValueChange={() => {}} ariaLabel="Start time" disabled />,
    );
    expect(screen.getByRole("combobox", { name: "Start time" })).toBeDisabled();
  });

  it("forwards triggerClassName and id to the trigger", () => {
    render(
      <TimeSelect
        value="09:00"
        onValueChange={() => {}}
        ariaLabel="t"
        triggerClassName="h-8"
        id="start-time"
      />,
    );
    const trigger = screen.getByRole("combobox", { name: "t" });
    expect(trigger).toHaveClass("h-8");
    expect(trigger).toHaveAttribute("id", "start-time");
  });

  it("shows the placeholder when no value is selected", () => {
    render(
      <TimeSelect value={undefined} onValueChange={() => {}} ariaLabel="t" placeholder="Pick a time" />,
    );
    expect(screen.getByRole("combobox", { name: "t" })).toHaveTextContent("Pick a time");
  });
});
