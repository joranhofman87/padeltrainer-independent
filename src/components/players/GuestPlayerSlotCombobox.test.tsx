import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ComponentProps } from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { GuestPlayerSlotCombobox } from "./GuestPlayerSlotCombobox";
import type { GuestPlayer } from "./guestPlayer";

const players: GuestPlayer[] = [
  {
    id: "p1",
    trainer_id: "t1",
    academy_profile_id: null,
    first_name: "Anna",
    last_name: "A",
    full_name: "Anna Alpha",
    email: "anna@example.com",
    phone: "",
    skill_rating: null,
    rating_system: "",
    notes: null,
    linked_profile_id: null,
    created_at: "",
    updated_at: "",
  },
  {
    id: "p2",
    trainer_id: "t1",
    academy_profile_id: null,
    first_name: "Bob",
    last_name: "B",
    full_name: "Bob Beta",
    email: "bob@example.com",
    phone: "",
    skill_rating: null,
    rating_system: "",
    notes: null,
    linked_profile_id: null,
    created_at: "",
    updated_at: "",
  },
];

function renderCombobox(
  props: Partial<ComponentProps<typeof GuestPlayerSlotCombobox>> = {},
) {
  const onValueChange = vi.fn();
  const result = render(
    <GuestPlayerSlotCombobox
      players={players}
      value=""
      placeholder="Select player"
      onValueChange={onValueChange}
      data-testid="player-combobox"
      {...props}
    />,
  );
  return { ...result, onValueChange };
}

describe("GuestPlayerSlotCombobox", () => {
  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn();
  });

  it("closes the dropdown after selecting a player", async () => {
    renderCombobox();
    const trigger = screen.getByTestId("player-combobox");
    expect(trigger).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");

    fireEvent.click(screen.getByText("Anna Alpha"));
    await waitFor(() => {
      expect(trigger).toHaveAttribute("aria-expanded", "false");
    });
  });

  it("keeps the selected player visible on the trigger after close", async () => {
    const onValueChange = vi.fn();
    const { rerender } = renderCombobox({ onValueChange });
    fireEvent.click(screen.getByTestId("player-combobox"));
    fireEvent.click(screen.getByText("Bob Beta"));

    expect(onValueChange).toHaveBeenCalledWith("p2");
    rerender(
      <GuestPlayerSlotCombobox
        players={players}
        value="p2"
        placeholder="Select player"
        onValueChange={onValueChange}
        data-testid="player-combobox"
      />,
    );
    expect(screen.getByTestId("player-combobox")).toHaveTextContent("Bob Beta");
  });

  it("can reopen the dropdown to select another player", async () => {
    const { rerender } = renderCombobox();
    fireEvent.click(screen.getByTestId("player-combobox"));
    fireEvent.click(screen.getByText("Anna Alpha"));
    await waitFor(() =>
      expect(screen.getByTestId("player-combobox")).toHaveAttribute(
        "aria-expanded",
        "false",
      ),
    );

    rerender(
      <GuestPlayerSlotCombobox
        players={players}
        value="p1"
        placeholder="Select player"
        onValueChange={vi.fn()}
        data-testid="player-combobox"
      />,
    );

    fireEvent.click(screen.getByTestId("player-combobox"));
    expect(screen.getByTestId("player-combobox")).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    fireEvent.click(screen.getByText("Bob Beta"));
    await waitFor(() =>
      expect(screen.getByTestId("player-combobox")).toHaveAttribute(
        "aria-expanded",
        "false",
      ),
    );
  });

  it("clears selection via clear item and closes the dropdown", async () => {
    const onValueChange = vi.fn();
    const { rerender } = render(
      <GuestPlayerSlotCombobox
        players={players}
        value="p1"
        placeholder="Select player"
        onValueChange={onValueChange}
        data-testid="player-combobox"
      />,
    );

    fireEvent.click(screen.getByTestId("player-combobox"));
    fireEvent.click(screen.getByText("-"));

    expect(onValueChange).toHaveBeenCalledWith("");
    await waitFor(() =>
      expect(screen.getByTestId("player-combobox")).toHaveAttribute(
        "aria-expanded",
        "false",
      ),
    );
    rerender(
      <GuestPlayerSlotCombobox
        players={players}
        value=""
        placeholder="Select player"
        onValueChange={onValueChange}
        data-testid="player-combobox"
      />,
    );
    expect(screen.getByTestId("player-combobox")).toHaveTextContent(
      "Select player",
    );
  });

  it("does not select players disabled in other slots", () => {
    const onValueChange = vi.fn();
    renderCombobox({ disabledPlayerIds: ["p1"], onValueChange });

    fireEvent.click(screen.getByTestId("player-combobox"));
    fireEvent.click(screen.getByText("Anna Alpha"));

    expect(onValueChange).not.toHaveBeenCalled();
  });

  it("resets search input after selecting a player", async () => {
    renderCombobox();
    const trigger = screen.getByTestId("player-combobox");

    fireEvent.click(trigger);
    const input = screen.getByPlaceholderText("Select player");
    fireEvent.change(input, { target: { value: "bob" } });
    fireEvent.click(screen.getByText("Bob Beta"));

    await waitFor(() =>
      expect(trigger).toHaveAttribute("aria-expanded", "false"),
    );

    fireEvent.click(trigger);
    expect(screen.getByPlaceholderText("Select player")).toHaveValue("");
  });

  it("returns focus to the trigger after selecting a player", async () => {
    renderCombobox();
    const trigger = screen.getByTestId("player-combobox");

    fireEvent.click(trigger);
    fireEvent.click(screen.getByText("Anna Alpha"));

    await waitFor(() => {
      expect(trigger).toHaveAttribute("aria-expanded", "false");
      expect(document.activeElement).toBe(trigger);
    });
  });

  it("marks already-selected players as disabled in the list", () => {
    renderCombobox({ disabledPlayerIds: ["p1"] });
    fireEvent.click(screen.getByTestId("player-combobox"));
    const annaItem = screen
      .getByText("Anna Alpha")
      .closest("[cmdk-item]");
    expect(annaItem).toHaveAttribute("aria-disabled", "true");
  });
});
