import { describe, expectTypeOf, it } from "vitest";
import {
  type APIPromise,
  type ChoiceResponse,
  choice,
  type ModelCard,
  type NoulQuestion,
  type NoulResponse,
  noul,
  type Question,
  type RetryPolicy,
  type ScoreResponse,
  type SystemOneResult,
  score,
  type TypeSafeClient,
  type WithResponse,
} from "../src";

declare const client: TypeSafeClient;

describe("systemOne result inference", () => {
  it("maps each question to its response type with literal criteria keys", async () => {
    const r = await client.systemOne({
      state: "s",
      questions: {
        a: noul("x"),
        b: choice("y", { yes: null, no: "desc" }),
        c: score("z", ["bad", "ok"]),
      },
    });

    expectTypeOf(r.answers.a).toEqualTypeOf<NoulResponse>();
    expectTypeOf(r.answers.a.noul).toEqualTypeOf<number>();

    expectTypeOf(r.answers.b).toEqualTypeOf<
      ChoiceResponse<{ readonly yes: null; readonly no: "desc" }>
    >();
    expectTypeOf(r.answers.b.choice).toEqualTypeOf<"yes" | "no">();
    expectTypeOf(r.answers.b.probabilities).toEqualTypeOf<{
      readonly yes: number;
      readonly no: number;
    }>();

    expectTypeOf(r.answers.c).toEqualTypeOf<ScoreResponse<readonly ["bad", "ok"]>>();
    expectTypeOf(r.answers.c.score).toEqualTypeOf<number>();
    expectTypeOf(r.answers.c.legend).toEqualTypeOf<{ readonly 0: "bad"; readonly 1: "ok" }>();
    expectTypeOf(r.answers.c.probabilities).toEqualTypeOf<{
      readonly 0: number;
      readonly 1: number;
    }>();
    // @ts-expect-error score 2 was not defined
    r.answers.c.probabilities[2];

    // @ts-expect-error unknown choice key
    r.answers.b.probabilities.maybe;
    // @ts-expect-error unknown answer key
    r.answers.d;
    // @ts-expect-error stats was removed
    r.answers.a.stats;
    // @ts-expect-error assets_used was removed
    r.assets_used;
  });

  it("types score lists by index, with the legend keyed by score", async () => {
    const r = await client.systemOne({
      state: "s",
      questions: { c: score("z", ["bad", "ok", { rich: "great" }]) },
    });
    expectTypeOf(r.answers.c.probabilities).toEqualTypeOf<{
      readonly 0: number;
      readonly 1: number;
      readonly 2: number;
    }>();
    expectTypeOf(r.answers.c.legend).toEqualTypeOf<{
      readonly 0: "bad";
      readonly 1: "ok";
      readonly 2: { readonly rich: "great" };
    }>();
    expectTypeOf(r.answers.c.legend[2].rich).toEqualTypeOf<"great">();
    // @ts-expect-error score 3 was not defined
    r.answers.c.probabilities[3];
    // @ts-expect-error score 3 was not defined
    r.answers.c.legend[3];
  });

  it("degrades to numeric indexing for non-literal score lists", async () => {
    const list: [string, string, ...string[]] = ["a", "b"];
    const r = await client.systemOne({ state: "s", questions: { c: score("z", list) } });
    expectTypeOf(r.answers.c.probabilities).toEqualTypeOf<{ readonly [score: number]: number }>();
    expectTypeOf(r.answers.c.legend).toEqualTypeOf<{ readonly [score: number]: string }>();
  });

  it("results are readonly", async () => {
    const r = await client.systemOne({ state: "s", questions: { a: noul("x") } });
    // @ts-expect-error readonly
    r.model = "other";
    // @ts-expect-error readonly
    r.answers.a.noul = 1;
    // @ts-expect-error readonly
    r.usage.input_tokens = 0;
    const models = await client.models.list();
    // @ts-expect-error readonly
    models[0].name = "other";
    // @ts-expect-error employee-only fields are available through raw access
    models[0].tags;
    expectTypeOf<ModelCard>().toEqualTypeOf<{
      readonly name: string;
      readonly description: string;
      readonly release_date: string;
    }>();
  });

  it("client settings are readonly", () => {
    // @ts-expect-error readonly
    client.defaultModel = "x";
    // @ts-expect-error readonly
    client.models = null;
    // @ts-expect-error readonly
    client.retry = {};
    // @ts-expect-error readonly
    client.retry.maxRetries = 0;
    expectTypeOf(client.retry).toEqualTypeOf<RetryPolicy>();
    expectTypeOf(client.retry.httpStatuses).toEqualTypeOf<ReadonlySet<number>>();
  });

  it("accepts a partial retry policy on the client and per call", () => {
    const partial: Partial<RetryPolicy> = { maxRetries: 1, httpStatuses: new Set([503]) };
    void partial;
    client.models.list({ retry: { httpStatuses: new Set([503]), backoffJitter: 0 } });
    // @ts-expect-error statuses are a set, as in the Python SDK
    client.models.list({ retry: { httpStatuses: [503] } });
    // @ts-expect-error unknown policy field
    client.models.list({ retry: { predicate: () => true } });
    // @ts-expect-error retry moved under the policy object
    client.models.list({ maxRetries: 0 });
  });
});

describe("criteria shapes", () => {
  it("rejects label-list shorthand for choice", () => {
    // @ts-expect-error criteria must be a map
    choice("q", ["a", "b"]);
    // @ts-expect-error empty label lists are not maps
    choice("q", []);
    const labels: string[] = ["a", "b"];
    // @ts-expect-error dynamic label lists are not maps
    choice("q", labels);
  });

  it("rejects numeric-keyed maps for score", () => {
    // @ts-expect-error score criteria must be a list
    score("q", { 0: "bad", 1: "ok" });
    // @ts-expect-error empty lists are not valid rubrics
    score("q", []);
    // @ts-expect-error a rubric needs at least two levels
    score("q", ["only"]);
    const dynamic: string[] = ["bad", "ok"];
    // @ts-expect-error a plain string[] may be empty
    score("q", dynamic);
    // @ts-expect-error inference is a client method, not a resource
    client.systemOne.run({ state: "s", questions: { q: noul("?") } });
  });
});

describe("question helpers", () => {
  it("constrains descriptions while allowing null for every question type", () => {
    // @ts-expect-error numbers are not valid descriptions
    choice("q", { yes: 1 });
    // @ts-expect-error numbers are not valid descriptions
    score("q", [1, 2]);
    score("q", ["ok", null]);
    noul(null, { true: null, false: null });
    noul(null, null);
    noul();
    choice(null, { yes: null });
    score(null, [null, null]);
    choice("q", { yes: null, no: "ok", maybe: { detail: "rich" } });
    score("q", ["bad", "ok", { detail: "rich" }]);
    noul("q", { true: { detail: "rich" } });
    noul("q", { false: "only one side" });
  });

  it("preserves result inference with nulls, arrays, and omitted instructions", async () => {
    const r = await client.systemOne({
      state: null,
      questions: {
        noul: { type: "noul" },
        choice: { type: "choice", criteria: { yes: null, no: [null, "example"] } },
        list: score(null, [null, "high"]),
        literal: { type: "score", criteria: [null, "high"] },
      },
    });
    expectTypeOf(r.answers.noul).toEqualTypeOf<NoulResponse>();
    expectTypeOf(r.answers.choice.choice).toEqualTypeOf<"yes" | "no">();
    expectTypeOf(r.answers.list.legend).toEqualTypeOf<{ readonly 0: null; readonly 1: "high" }>();
    expectTypeOf(r.answers.literal.legend).toEqualTypeOf<{
      readonly 0: null;
      readonly 1: "high";
    }>();
    expectTypeOf(r.answers.list.probabilities).toEqualTypeOf<{
      readonly 0: number;
      readonly 1: number;
    }>();
    client.systemOne({
      state: [null, { nested: [true, 1] }],
      questions: {
        q: noul([null, "instructions"], { true: [null, "criterion"] }),
        c: choice(["instructions"], { yes: [null, "criterion"] }),
        s: score(["instructions"], [[null, "criterion"], null]),
      },
    });
  });

  it("are all assignable to Question", () => {
    expectTypeOf(noul("x")).toMatchTypeOf<Question>();
    expectTypeOf(choice("x", { a: null })).toMatchTypeOf<Question>();
    expectTypeOf(choice("x", { a: null, b: null })).toMatchTypeOf<Question>();
    expectTypeOf(score("x", ["a", "b"])).toMatchTypeOf<Question>();
  });
});

describe("APIPromise", () => {
  it("client methods return APIPromise", () => {
    expectTypeOf(client.models.list()).toEqualTypeOf<APIPromise<ModelCard[]>>();
    const p = client.systemOne({ state: "s", questions: { a: noul("x") } });
    expectTypeOf(p).toEqualTypeOf<APIPromise<SystemOneResult<{ readonly a: NoulQuestion }>>>();
    expectTypeOf(p.withResponse()).toEqualTypeOf<
      Promise<WithResponse<SystemOneResult<{ readonly a: NoulQuestion }>>>
    >();
    expectTypeOf(p.asResponse()).toEqualTypeOf<Promise<Response>>();
  });

  it("awaiting yields the plain result", async () => {
    const r = await client.systemOne({ state: "s", questions: { a: noul("x") } });
    expectTypeOf(r).toEqualTypeOf<SystemOneResult<{ readonly a: NoulQuestion }>>();
    const { data, requestId } = await client
      .systemOne({ state: "s", questions: { a: noul("x") } })
      .withResponse();
    expectTypeOf(data.answers.a).toEqualTypeOf<NoulResponse>();
    expectTypeOf(requestId).toEqualTypeOf<string | undefined>();
  });
});

describe("choice wire labels", () => {
  it("stringifies numeric labels and preserves mixed and quoted labels", async () => {
    const { answers } = await client.systemOne({
      state: null,
      questions: {
        numeric: choice(null, { 0: null, 1: null }),
        mixed: choice(null, { 0: null, other: null }),
        quoted: choice(null, { "0": null, "1": null }),
      },
    });
    expectTypeOf(answers.numeric.choice).toEqualTypeOf<"0" | "1">();
    expectTypeOf(answers.mixed.choice).toEqualTypeOf<"0" | "other">();
    expectTypeOf(answers.quoted.choice).toEqualTypeOf<"0" | "1">();
    expectTypeOf(answers.numeric.probabilities).toEqualTypeOf<{
      readonly "0": number;
      readonly "1": number;
    }>();
    expectTypeOf(answers.mixed.probabilities).toEqualTypeOf<{
      readonly "0": number;
      readonly other: number;
    }>();
    expectTypeOf(answers.numeric.probabilities[answers.numeric.choice]).toEqualTypeOf<number>();
    expectTypeOf(answers.numeric.probabilities[0]).toEqualTypeOf<number>();
  });

  it("preserves readonly numeric criteria, including negative and fractional labels", async () => {
    const criteria: Readonly<{ "-1": null; 1.5: null }> = { "-1": null, 1.5: null };
    const { answers } = await client.systemOne({
      state: null,
      questions: { value: choice(null, criteria) },
    });
    expectTypeOf(answers.value.choice).toEqualTypeOf<"-1" | "1.5">();
    expectTypeOf<keyof typeof answers.value.probabilities>().toEqualTypeOf<"-1" | "1.5">();
  });

  it("supports non-literal numeric and string criteria maps", async () => {
    const numeric: Record<number, null> = { 0: null, 1: null };
    const strings: Record<string, null> = { yes: null, no: null };
    const { answers } = await client.systemOne({
      state: null,
      questions: { numeric: choice(null, numeric), strings: choice(null, strings) },
    });
    expectTypeOf(answers.numeric.choice).toEqualTypeOf<`${number}`>();
    expectTypeOf<keyof typeof answers.numeric.probabilities>().toEqualTypeOf<`${number}`>();
    expectTypeOf(answers.strings.choice).toEqualTypeOf<string>();
    expectTypeOf<ChoiceResponse["choice"]>().toEqualTypeOf<string>();
  });
});
