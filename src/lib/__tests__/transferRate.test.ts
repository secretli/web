import { formatRate, formatTimeLeft, RateMeter } from "../transferRate";

describe("RateMeter", () => {
  it("says nothing until it has seen a couple of seconds", () => {
    const meter = new RateMeter();
    meter.add(0, 0);
    meter.add(1_000_000, 1_000);
    expect(meter.rate(1_000)).toBeNull();
    expect(meter.rate(2_000)).toBe(500_000);
  });

  it("measures over the last few seconds, not since the start", () => {
    const meter = new RateMeter();
    // Fast at first, then 100 kB/s for ten seconds.
    meter.add(0, 0);
    meter.add(10_000_000, 1_000);
    for (let s = 2; s <= 12; s++) meter.add(10_000_000 + (s - 1) * 100_000, s * 1_000);
    const rate = meter.rate(12_000) ?? 0;
    expect(rate).toBeGreaterThan(90_000);
    expect(rate).toBeLessThan(110_000);
  });

  it("falls as time passes without progress", () => {
    const meter = new RateMeter();
    meter.add(0, 0);
    meter.add(4_000_000, 4_000);
    expect(meter.rate(4_000)).toBe(1_000_000);
    expect(meter.rate(8_000)).toBe(500_000);
    expect(meter.stillFor(8_000)).toBe(4_000);
  });

  it("starts over when the count goes back, as when a part is sent again", () => {
    const meter = new RateMeter();
    meter.add(0, 0);
    meter.add(5_000_000, 5_000);
    meter.add(1_000_000, 6_000);
    expect(meter.rate(7_000)).toBeNull();
    meter.add(3_000_000, 8_000);
    expect(meter.rate(8_000)).toBe(1_000_000);
  });

  it("has not stood still before anything moved", () => {
    expect(new RateMeter().stillFor(10_000)).toBe(0);
  });
});

describe("formatTimeLeft", () => {
  it("rounds the way a person would say it", () => {
    expect(formatTimeLeft(4)).toBe("a few seconds left");
    expect(formatTimeLeft(34)).toBe("about 30 s left");
    expect(formatTimeLeft(58)).toBe("about 1 min left");
    expect(formatTimeLeft(150)).toBe("about 3 min left");
    expect(formatTimeLeft(3 * 3600 + 20 * 60)).toBe("about 3 h 20 min left");
  });
});

describe("formatRate", () => {
  it("uses MB/s from a megabyte up, KB/s below", () => {
    expect(formatRate(1.5 * 1024 * 1024)).toBe("1.5 MB/s");
    expect(formatRate(340 * 1024)).toBe("340 KB/s");
    expect(formatRate(10)).toBe("1 KB/s");
  });
});
