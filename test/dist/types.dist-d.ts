import { describe, expectTypeOf, it } from "vitest";
import { type TypeSafeClient as CjsClient, choice as cjsChoice } from "../../dist/index.cjs";
// Resolves to dist/index.d.mts: this checks the *emitted* declarations, not the sources.
import { choice, noul, score, type TypeSafeClient } from "../../dist/index.mjs";

declare const client: TypeSafeClient;
declare const cjsClient: CjsClient;

describe("emitted declarations", () => {
  it("preserve literal inference through the bundle", async () => {
    const { answers } = await client.systemOne({
      state: null,
      questions: {
        a: noul(null),
        b: choice(null, { yes: null, no: null }),
        c: score(null, [null, "high"]),
        d: { type: "noul" },
      },
    });
    expectTypeOf(answers.a.noul).toEqualTypeOf<number>();
    expectTypeOf(answers.b.choice).toEqualTypeOf<"yes" | "no">();
    expectTypeOf(answers.b.probabilities).toEqualTypeOf<{
      readonly yes: number;
      readonly no: number;
    }>();
    expectTypeOf(answers.c.legend).toEqualTypeOf<{ readonly 0: null; readonly 1: "high" }>();
    expectTypeOf(answers.d.noul).toEqualTypeOf<number>();
    // @ts-expect-error unknown label
    answers.b.probabilities.maybe;
  });
});

it("preserves numeric and mixed choice labels through both declaration entrypoints", async () => {
  const esm = await client.systemOne({
    state: null,
    questions: { q: choice(null, { 0: null, 1: null, other: null }) },
  });
  const cjs = await cjsClient.systemOne({
    state: null,
    questions: { q: cjsChoice(null, { 0: null, 1: null, other: null }) },
  });
  expectTypeOf(esm.answers.q.choice).toEqualTypeOf<"0" | "1" | "other">();
  expectTypeOf(cjs.answers.q.choice).toEqualTypeOf<"0" | "1" | "other">();
  expectTypeOf<keyof typeof esm.answers.q.probabilities>().toEqualTypeOf<"0" | "1" | "other">();
  expectTypeOf<keyof typeof cjs.answers.q.probabilities>().toEqualTypeOf<"0" | "1" | "other">();
  expectTypeOf(esm.answers.q.probabilities[esm.answers.q.choice]).toEqualTypeOf<number>();
  expectTypeOf(cjs.answers.q.probabilities[cjs.answers.q.choice]).toEqualTypeOf<number>();
});
