import { describe, expect, test } from "bun:test";
import { parseDuration } from "../src/duration.ts";

describe("hours and minutes", () => {
  test("2h", () => expect(parseDuration("2h")).toBe(7_200_000));
  test("45m", () => expect(parseDuration("45m")).toBe(2_700_000));
  test("1h30m", () => expect(parseDuration("1h30m")).toBe(5_400_000));
});

describe("seconds and milliseconds", () => {
  test("90s", () => expect(parseDuration("90s")).toBe(90_000));
  test("250ms", () => expect(parseDuration("250ms")).toBe(250));
  test("1m30s", () => expect(parseDuration("1m30s")).toBe(90_000));
});

describe("errors", () => {
  test("empty", () => expect(() => parseDuration("")).toThrow(RangeError));
  test("unknown unit", () => expect(() => parseDuration("3d")).toThrow(/3d/));
  test("repeated unit", () => expect(() => parseDuration("1h1h")).toThrow(RangeError));
});
