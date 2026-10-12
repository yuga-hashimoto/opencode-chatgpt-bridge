import { describe, expect, it } from "vitest";
import { isTerminalOpencodeStatus, isBusyOpencodeStatus } from "../src/types.js";

describe("Opencode Status Helpers", () => {
  describe("isTerminalOpencodeStatus", () => {
    it("returns true for { type: 'idle' }", () => {
      expect(isTerminalOpencodeStatus({ type: "idle" })).toBe(true);
    });

    it("returns true for { type: 'completed' }", () => {
      expect(isTerminalOpencodeStatus({ type: "completed" })).toBe(true);
    });

    it("returns true for { type: 'error' }", () => {
      expect(isTerminalOpencodeStatus({ type: "error" })).toBe(true);
    });

    it("returns true for { type: 'cancelled' }", () => {
      expect(isTerminalOpencodeStatus({ type: "cancelled" })).toBe(true);
    });

    it("returns true for legacy { status: 'idle' }", () => {
      expect(isTerminalOpencodeStatus({ status: "idle" })).toBe(true);
    });

    it("returns true for legacy { status: 'completed' }", () => {
      expect(isTerminalOpencodeStatus({ status: "completed" })).toBe(true);
    });

    it("returns true for legacy { status: 'error' }", () => {
      expect(isTerminalOpencodeStatus({ status: "error" })).toBe(true);
    });

    it("returns true for legacy { status: 'cancelled' }", () => {
      expect(isTerminalOpencodeStatus({ status: "cancelled" })).toBe(true);
    });

    it("returns false for { type: 'busy' }", () => {
      expect(isTerminalOpencodeStatus({ type: "busy" })).toBe(false);
    });

    it("returns false for { type: 'running' }", () => {
      expect(isTerminalOpencodeStatus({ type: "running" })).toBe(false);
    });

    it("returns false for legacy { status: 'running' }", () => {
      expect(isTerminalOpencodeStatus({ status: "running" })).toBe(false);
    });

    it("returns false for legacy { status: 'busy' }", () => {
      expect(isTerminalOpencodeStatus({ status: "busy" })).toBe(false);
    });

    it("returns false for null", () => {
      expect(isTerminalOpencodeStatus(null)).toBe(false);
    });

    it("returns false for undefined", () => {
      expect(isTerminalOpencodeStatus(undefined)).toBe(false);
    });

    it("returns false for empty object", () => {
      expect(isTerminalOpencodeStatus({})).toBe(false);
    });

    it("returns false for unknown type", () => {
      expect(isTerminalOpencodeStatus({ type: "unknown" })).toBe(false);
    });

    it("returns false for unknown status", () => {
      expect(isTerminalOpencodeStatus({ status: "unknown" })).toBe(false);
    });
  });

  describe("isBusyOpencodeStatus", () => {
    it("returns true for { type: 'busy' }", () => {
      expect(isBusyOpencodeStatus({ type: "busy" })).toBe(true);
    });

    it("returns true for { type: 'running' }", () => {
      expect(isBusyOpencodeStatus({ type: "running" })).toBe(true);
    });

    it("returns true for legacy { status: 'busy' }", () => {
      expect(isBusyOpencodeStatus({ status: "busy" })).toBe(true);
    });

    it("returns true for legacy { status: 'running' }", () => {
      expect(isBusyOpencodeStatus({ status: "running" })).toBe(true);
    });

    it("returns false for { type: 'idle' }", () => {
      expect(isBusyOpencodeStatus({ type: "idle" })).toBe(false);
    });

    it("returns false for { type: 'completed' }", () => {
      expect(isBusyOpencodeStatus({ type: "completed" })).toBe(false);
    });

    it("returns false for { type: 'error' }", () => {
      expect(isBusyOpencodeStatus({ type: "error" })).toBe(false);
    });

    it("returns false for { type: 'cancelled' }", () => {
      expect(isBusyOpencodeStatus({ type: "cancelled" })).toBe(false);
    });

    it("returns false for legacy { status: 'idle' }", () => {
      expect(isBusyOpencodeStatus({ status: "idle" })).toBe(false);
    });

    it("returns false for legacy { status: 'completed' }", () => {
      expect(isBusyOpencodeStatus({ status: "completed" })).toBe(false);
    });

    it("returns false for legacy { status: 'error' }", () => {
      expect(isBusyOpencodeStatus({ status: "error" })).toBe(false);
    });

    it("returns false for legacy { status: 'cancelled' }", () => {
      expect(isBusyOpencodeStatus({ status: "cancelled" })).toBe(false);
    });

    it("returns false for null", () => {
      expect(isBusyOpencodeStatus(null)).toBe(false);
    });

    it("returns false for undefined", () => {
      expect(isBusyOpencodeStatus(undefined)).toBe(false);
    });

    it("returns false for empty object", () => {
      expect(isBusyOpencodeStatus({})).toBe(false);
    });
  });
});