import { describe, expect, it, vi } from "vitest";
import { sleep } from "./sleep.js";

describe("sleep", () => {
  it("resolve depois do tempo pedido via setTimeout", async () => {
    vi.useFakeTimers();
    const spy = vi.fn();
    void sleep(1000).then(spy);

    await vi.advanceTimersByTimeAsync(999);
    expect(spy).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(spy).toHaveBeenCalledOnce();

    vi.useRealTimers();
  });
});
