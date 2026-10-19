// Exercises the node's execute() paths with mocked n8n helpers. No network access required.
const assert = require('node:assert');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const { SalesforceSession } = require(path.join(ROOT, 'dist/nodes/SalesforceSession/SalesforceSession.node.js'));

function makeCtx({ params, credentials, httpRequest, httpRequestWithAuthentication }) {
  return {
    getInputData: () => [{ json: {} }],
    getNodeParameter: (name, _i, fallback) => (name in params ? params[name] : fallback),
    getCredentials: async () => credentials,
    getNode: () => ({ name: 'Salesforce Session', type: 'salesforceSession', typeVersion: 1, position: [0, 0], parameters: {} }),
    continueOnFail: () => false,
    helpers: { httpRequest, httpRequestWithAuthentication },
  };
}

(async () => {
  // 1. Stored session: no login, no probe.
  let loginCalls = 0;
  let probeCalls = 0;
  let ctx = makeCtx({
    params: { operation: 'getSession' },
    credentials: { sessionId: 'SID-STORED', instanceUrl: 'https://na1.salesforce.com', authMode: 'cookie', apiVersion: '62.0' },
    httpRequest: async () => { loginCalls++; return {}; },
    httpRequestWithAuthentication: async () => { probeCalls++; return []; },
  });
  let out = await new SalesforceSession().execute.call(ctx);
  assert.strictEqual(loginCalls, 0, 'no direct login');
  assert.strictEqual(probeCalls, 0, 'no probe when session stored');
  assert.strictEqual(out[0][0].json.sessionId, 'SID-STORED');
  assert.strictEqual(out[0][0].json.instanceUrl, 'https://na1.salesforce.com');
  assert.strictEqual(out[0][0].json.cookieHeader, 'sid=SID-STORED');
  assert.strictEqual(out[0][0].json.authorizationHeader, 'Bearer SID-STORED');
  assert.deepStrictEqual(out[0][0].pairedItem, { item: 0 });

  // 2. No stored session: one authenticated probe persists it.
  probeCalls = 0;
  const creds = { sessionId: '', instanceUrl: '', authMode: 'bearer', apiVersion: '62.0', loginUrl: 'https://login.salesforce.com' };
  ctx = makeCtx({
    params: { operation: 'getSession' },
    credentials: creds,
    httpRequest: async () => { throw new Error('node must not log in directly'); },
    httpRequestWithAuthentication: async (type, o) => {
      probeCalls++;
      assert.strictEqual(type, 'salesforceSessionApi');
      assert.strictEqual(o.url, 'https://login.salesforce.com/services/data/v62.0/');
      assert.strictEqual(o.ignoreHttpStatusErrors, true);
      creds.sessionId = 'SID-FRESH';
      creds.instanceUrl = 'https://eu12.salesforce.com';
      return [];
    },
  });
  out = await new SalesforceSession().execute.call(ctx);
  assert.strictEqual(probeCalls, 1, 'probes once to persist');
  assert.strictEqual(out[0][0].json.sessionId, 'SID-FRESH');
  assert.strictEqual(out[0][0].json.instanceUrl, 'https://eu12.salesforce.com');

  // 2b. Failed login surfaces a clear error.
  ctx = makeCtx({
    params: { operation: 'getSession' },
    credentials: { sessionId: '', instanceUrl: '', apiVersion: '62.0', loginUrl: 'https://login.salesforce.com' },
    httpRequest: async () => { throw new Error('unused'); },
    httpRequestWithAuthentication: async () => [],
  });
  await assert.rejects(() => new SalesforceSession().execute.call(ctx), /did not return a session/);

  // 3. Request operation builds URL and forwards options.
  let captured;
  ctx = makeCtx({
    params: {
      operation: 'request', method: 'POST', endpoint: 'sobjects/Account',
      headers: '{"X-Custom":"1"}', queryParameters: '{"q":"x"}', body: '{"Name":"Acme"}',
      options: { fullResponse: true, timeout: 5000 },
    },
    credentials: { sessionId: 'SID-STORED', instanceUrl: 'https://na1.salesforce.com', apiVersion: '62.0' },
    httpRequest: async () => { throw new Error('should not log in'); },
    httpRequestWithAuthentication: async (type, o) => { captured = o; return { statusCode: 201, headers: {}, body: { id: '001' } }; },
  });
  out = await new SalesforceSession().execute.call(ctx);
  assert.strictEqual(captured.url, 'https://na1.salesforce.com/services/data/v62.0/sobjects/Account');
  assert.strictEqual(captured.method, 'POST');
  assert.deepStrictEqual(captured.headers, { 'X-Custom': '1' });
  assert.deepStrictEqual(captured.qs, { q: 'x' });
  assert.deepStrictEqual(captured.body, { Name: 'Acme' });
  assert.strictEqual(captured.returnFullResponse, true);
  assert.strictEqual(captured.timeout, 5000);
  assert.deepStrictEqual(out[0][0].json, { statusCode: 201, headers: {}, body: { id: '001' } });

  // 4. Endpoint variants.
  for (const [endpoint, expected] of [
    ['https://other.example.com/x', 'https://other.example.com/x'],
    ['services/data/v61.0/limits', 'https://na1.salesforce.com/services/data/v61.0/limits'],
    ['', 'https://na1.salesforce.com/services/data/v62.0/'],
    ['/sobjects/', 'https://na1.salesforce.com/services/data/v62.0/sobjects/'],
  ]) {
    ctx = makeCtx({
      params: { operation: 'request', method: 'GET', endpoint, headers: '{}', queryParameters: '{}', options: {} },
      credentials: { sessionId: 'S', instanceUrl: 'https://na1.salesforce.com', apiVersion: '62.0' },
      httpRequest: async () => { throw new Error('no login'); },
      httpRequestWithAuthentication: async (t, o) => { captured = o; return {}; },
    });
    await new SalesforceSession().execute.call(ctx);
    assert.strictEqual(captured.url, expected, `endpoint ${endpoint}`);
    assert.strictEqual(captured.body, undefined, 'GET has no body');
  }

  // 5. Invalid JSON parameter.
  ctx = makeCtx({
    params: { operation: 'request', method: 'GET', endpoint: 'x', headers: 'not-json', queryParameters: '{}', options: {} },
    credentials: { sessionId: 'S', instanceUrl: 'https://na1.salesforce.com', apiVersion: '62.0' },
    httpRequest: async () => { throw new Error('no login'); },
    httpRequestWithAuthentication: async () => ({}),
  });
  await assert.rejects(() => new SalesforceSession().execute.call(ctx), /must be valid JSON/);

  // 6. continueOnFail collects the error.
  ctx = makeCtx({
    params: { operation: 'request', method: 'GET', endpoint: 'x', headers: '{}', queryParameters: '{}', options: {} },
    credentials: { sessionId: 'S', instanceUrl: 'https://na1.salesforce.com', apiVersion: '62.0' },
    httpRequest: async () => { throw new Error('no login'); },
    httpRequestWithAuthentication: async () => { throw new Error('kaboom'); },
  });
  ctx.continueOnFail = () => true;
  out = await new SalesforceSession().execute.call(ctx);
  assert.match(out[0][0].json.error, /kaboom/);

  console.log('Execute tests passed.');
})().catch((e) => { console.error(e); process.exit(1); });
