import { test, expect, describe, beforeEach } from "vitest";
import { useUI, type ConfirmRequest } from "./ui";

const req = (title: string): ConfirmRequest => ({ title, onConfirm: () => {} });

beforeEach(() => {
  useUI.setState({ confirm: null, confirmQueue: [] });
});

describe("confirm queue", () => {
  test("shows immediately when nothing is open", () => {
    useUI.getState().requestConfirm(req("A"));
    expect(useUI.getState().confirm?.title).toBe("A");
    expect(useUI.getState().confirmQueue).toHaveLength(0);
  });

  test("a second request queues behind the open one instead of clobbering it", () => {
    useUI.getState().requestConfirm(req("A"));
    useUI.getState().requestConfirm(req("B"));
    expect(useUI.getState().confirm?.title).toBe("A"); // still showing the first
    expect(useUI.getState().confirmQueue.map((r) => r.title)).toEqual(["B"]);
  });

  test("clearing advances to the queued one, then closes when empty", () => {
    useUI.getState().requestConfirm(req("A"));
    useUI.getState().requestConfirm(req("B"));

    useUI.getState().clearConfirm();
    expect(useUI.getState().confirm?.title).toBe("B");
    expect(useUI.getState().confirmQueue).toHaveLength(0);

    useUI.getState().clearConfirm();
    expect(useUI.getState().confirm).toBeNull();
  });

  test("clearing with an empty queue just closes", () => {
    useUI.getState().requestConfirm(req("A"));
    useUI.getState().clearConfirm();
    expect(useUI.getState().confirm).toBeNull();
    expect(useUI.getState().confirmQueue).toHaveLength(0);
  });
});
