const test = require('node:test');
const assert = require('node:assert/strict');

const {
  pricingSortValue,
  resolveModels,
  selectLowestPricedModels,
} = require('../src/index');

test('定价排序与页面规则一致', () => {
  const data = [
    {
      model_name: 'low-input-but-high-output',
      quota_type: 0,
      model_ratio: 0.2,
      completion_ratio: 100,
      cache_ratio: 10,
    },
    { model_name: 'request-model', quota_type: 1, model_price: 0.1 },
    { model_name: 'tiered-model', quota_type: 0, model_ratio: 37.5 },
    { model_name: 'free-token-model', quota_type: 0, model_ratio: 0 },
  ];

  assert.deepEqual(selectLowestPricedModels(data, 3), [
    'free-token-model',
    'request-model',
    'low-input-but-high-output',
  ]);
});

test('相同排序值保持价格接口的原始顺序', () => {
  const data = [
    { model_name: 'first', quota_type: 0, model_ratio: 0.5 },
    { model_name: 'second', quota_type: 0, model_ratio: 0.5 },
  ];

  assert.deepEqual(selectLowestPricedModels(data, 5), ['first', 'second']);
});

test('按次计费模型未设置 model_price 时排序值为 0', () => {
  assert.equal(pricingSortValue({ quota_type: 1 }), 0);
});

test('价格接口没有可用模型时拒绝继续', () => {
  assert.throws(
    () => selectLowestPricedModels([{ model_name: '', quota_type: 0, model_ratio: 0 }], 5),
    /没有返回可用模型/,
  );
});

test('未配置 MODELS 时每次任务解析都会重新请求价格接口', async () => {
  const originalFetch = global.fetch;
  const originalLog = console.log;
  let requestCount = 0;
  global.fetch = async () => {
    requestCount += 1;
    return {
      ok: true,
      text: async () => JSON.stringify({
        success: true,
        data: [{
          model_name: `dynamic-model-${requestCount}`,
          quota_type: 0,
          model_ratio: requestCount,
        }],
      }),
    };
  };
  console.log = () => {};

  const config = {
    domain: 'https://example.com',
    apiKey: 'test-key',
    models: null,
    modelsCount: 1,
    requestTimeoutMs: 1000,
  };

  try {
    assert.deepEqual(await resolveModels(config), ['dynamic-model-1']);
    assert.deepEqual(await resolveModels(config), ['dynamic-model-2']);
    assert.equal(requestCount, 2);
  } finally {
    global.fetch = originalFetch;
    console.log = originalLog;
  }
});
