import { describe, it, expect } from "vitest";
import { convert } from "./json-schema-to-zod";

describe("convert(JsonSchema → Zod)", () => {
  it("rejects null with permissive fallback", () => {
    const r = convert(null);
    expect(r.fallback).toBe(true);
    expect(r.schema.safeParse({}).success).toBe(true); // permissive
  });

  it("converts object with required + optional fields", () => {
    const r = convert({
      type: "object",
      properties: {
        upload_id: { type: "string" },
        size: { type: "number" },
      },
      required: ["upload_id"],
    });
    expect(r.fallback).toBe(false);
    expect(r.schema.safeParse({ upload_id: "u1" }).success).toBe(true);
    expect(r.schema.safeParse({ upload_id: "u1", size: 42 }).success).toBe(true);
    expect(r.schema.safeParse({}).success).toBe(false);             // missing required
    expect(r.schema.safeParse({ upload_id: 1 }).success).toBe(false); // wrong type
  });

  it("respects additionalProperties=false", () => {
    const r = convert({
      type: "object",
      properties: { a: { type: "string" } },
      required: ["a"],
      additionalProperties: false,
    });
    expect(r.schema.safeParse({ a: "x", b: "y" }).success).toBe(false);
  });

  it("default to passthrough when additionalProperties unspecified", () => {
    const r = convert({
      type: "object",
      properties: { a: { type: "string" } },
      required: ["a"],
    });
    const p = r.schema.safeParse({ a: "x", extra: 99 });
    expect(p.success).toBe(true);
  });

  it("supports nested objects", () => {
    const r = convert({
      type: "object",
      properties: {
        payload: {
          type: "object",
          properties: { upload_id: { type: "string" } },
          required: ["upload_id"],
        },
      },
      required: ["payload"],
    });
    expect(r.schema.safeParse({ payload: { upload_id: "x" } }).success).toBe(true);
    expect(r.schema.safeParse({ payload: {} }).success).toBe(false);
  });

  it("supports arrays with item type", () => {
    const r = convert({ type: "array", items: { type: "string" } });
    expect(r.schema.safeParse(["a", "b"]).success).toBe(true);
    expect(r.schema.safeParse([1]).success).toBe(false);
  });

  it("supports enum of strings", () => {
    const r = convert({ enum: ["draft", "active", "retired"] });
    expect(r.schema.safeParse("active").success).toBe(true);
    expect(r.schema.safeParse("foo").success).toBe(false);
  });

  it("supports number constraints", () => {
    const r = convert({ type: "number", minimum: 0, maximum: 100 });
    expect(r.schema.safeParse(50).success).toBe(true);
    expect(r.schema.safeParse(-1).success).toBe(false);
    expect(r.schema.safeParse(101).success).toBe(false);
  });

  it("supports string regex", () => {
    const r = convert({ type: "string", pattern: "^[a-z]+$" });
    expect(r.schema.safeParse("abc").success).toBe(true);
    expect(r.schema.safeParse("ABC").success).toBe(false);
  });

  it("supports type: array union (string | null)", () => {
    const r = convert({ type: ["string", "null"] });
    expect(r.schema.safeParse("x").success).toBe(true);
    expect(r.schema.safeParse(null).success).toBe(true);
    expect(r.schema.safeParse(42).success).toBe(false);
  });

  it("supports oneOf", () => {
    const r = convert({
      oneOf: [{ type: "string" }, { type: "number" }],
    });
    expect(r.schema.safeParse("x").success).toBe(true);
    expect(r.schema.safeParse(7).success).toBe(true);
    expect(r.schema.safeParse(true).success).toBe(false);
  });

  it("falls back permissively when input is malformed", () => {
    const r = convert("not a schema");
    expect(r.fallback).toBe(true);
  });

  it("handles unknown type as permissive", () => {
    const r = convert({ type: "weirdo" });
    expect(r.schema.safeParse({ anything: 1 }).success).toBe(true);
  });

  it("handles bad regex without throwing — drops the constraint", () => {
    const r = convert({ type: "string", pattern: "[invalid" });
    expect(r.schema.safeParse("anything").success).toBe(true);
  });
});
