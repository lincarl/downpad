import { expect, it } from "vitest";
import { developmentEntryUrl } from "./security";

it.each([undefined, "", "http://127.0.0.1:1420/", "https://example.com/", "invalid URL"])(
  "ignores the packaged development override %s",
  (value) => { expect(developmentEntryUrl(value, true)).toBeUndefined(); },
);

it.each([undefined, ""])("uses bundled content without a development override %s", (value) => {
  expect(developmentEntryUrl(value, false)).toBeUndefined();
});

it.each([
  "http://localhost:1420/",
  "http://127.0.0.1:1481/",
  "http://[::1]:1420/",
  "https://localhost:1420/editor?test=1#section",
])("accepts an unpackaged loopback entry %s", (value) => {
  expect(developmentEntryUrl(value, false)).toBe(new URL(value).href);
});

it.each([
  "https://example.com/",
  "http://192.168.1.10:1420/",
  "http://localhost.example.com:1420/",
  "http://0.0.0.0:1420/",
  "http://127.0.0.1:1420@evil.example/",
  "http://user@localhost:1420/",
  "http://:password@127.0.0.1:1420/",
  "file:///index.html",
  "ftp://127.0.0.1/",
  "invalid URL",
])("rejects an unsafe unpackaged entry %s", (value) => {
  expect(() => developmentEntryUrl(value, false)).toThrow();
});
