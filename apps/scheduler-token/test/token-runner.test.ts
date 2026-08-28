import test from "node:test";
import assert from "node:assert/strict";
import {
  extractAssistantAnswer,
  pricingSortValue,
  selectLowestPricedModels,
} from "@scheduler/token/token-runner";

test("pricing uses the existing token/request sorting semantics", () => {
  const data = [
    { model_name: "token", quota_type: 0, model_ratio: 0.2 },
    { model_name: "request", quota_type: 1, model_price: 0.1 },
    { model_name: "free", quota_type: 0, model_ratio: 0 },
  ];
  assert.deepEqual(selectLowestPricedModels(data, 3), ["free", "request", "token"]);
  assert.equal(pricingSortValue({ quota_type: 1 }), 0);
});

test("dynamic pricing keeps duplicate models", () => {
  const data = [
    { model_name: "same", quota_type: 0, model_ratio: 0 },
    { model_name: "same", quota_type: 0, model_ratio: 1 },
  ];
  assert.deepEqual(selectLowestPricedModels(data, 2), ["same", "same"]);
});

test("assistant content is preferred and missing content falls back at the caller", () => {
  assert.equal(extractAssistantAnswer({ choices: [{ message: { content: "answer" } }] }), "answer");
  assert.equal(extractAssistantAnswer({ choices: [] }), null);
});
