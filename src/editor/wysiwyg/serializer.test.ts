import { describe, it, expect } from "vitest";
import { toRemarkStringifyOptions } from "./serializer";
import type { SerializerStyle } from "../../state/types";

const base: SerializerStyle = {
  bullet: "-",
  emphasis: "*",
  strong: "**",
  headingStyle: "atx",
  hardWrap: false,
};

describe("toRemarkStringifyOptions", () => {
  it("maps defaults (Prettier/LLM conventions)", () => {
    const o = toRemarkStringifyOptions(base);
    expect(o.bullet).toBe("-");
    expect(o.emphasis).toBe("*");
    expect(o.strong).toBe("*"); // "**" -> single repeated "*"
    expect(o.setext).toBe(false);
    expect(o.fences).toBe(true);
  });

  it("maps alternate styles", () => {
    const o = toRemarkStringifyOptions({
      ...base,
      bullet: "*",
      emphasis: "_",
      strong: "__",
      headingStyle: "setext",
    });
    expect(o.bullet).toBe("*");
    expect(o.emphasis).toBe("_");
    expect(o.strong).toBe("_"); // "__" -> "_"
    expect(o.setext).toBe(true);
  });
});
