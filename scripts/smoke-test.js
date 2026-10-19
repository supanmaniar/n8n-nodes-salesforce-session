// Smoke test for the SOAP login + session header logic. No network access required.
const assert = require('node:assert');
const {
	buildLoginEnvelope,
	parseLoginResponse,
	extractSoapFault,
	loginWithSoap,
	applySessionHeaders,
	normalizeApiVersion,
	normalizeBaseUrl,
} = require('../dist/nodes/SalesforceSession/session.js');

const LOGIN_OK = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns="urn:partner.soap.sforce.com">
  <soapenv:Body>
    <loginResponse>
      <result>
        <metadataServerUrl>https://na123.salesforce.com/services/Soap/m/62.0/00Dxx0000001abc</metadataServerUrl>
        <passwordExpired>false</passwordExpired>
        <sandbox>false</sandbox>
        <serverUrl>https://na123.salesforce.com/services/Soap/u/62.0/00Dxx0000001abc</serverUrl>
        <sessionId>00Dxx0000001abc!AQ4AQH8exampleSessionId</sessionId>
        <userId>005xx000001abc</userId>
      </result>
    </loginResponse>
  </soapenv:Body>
</soapenv:Envelope>`;

const LOGIN_FAULT = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">
  <soapenv:Body>
    <soapenv:Fault>
      <faultcode>sf:INVALID_LOGIN</faultcode>
      <faultstring>INVALID_LOGIN: Invalid username, password, security token; or user locked out.</faultstring>
    </soapenv:Fault>
  </soapenv:Body>
</soapenv:Envelope>`;

async function main() {
	// Envelope escaping
	const envelope = buildLoginEnvelope('a&b@example.com', 'p<w>d', 'tok');
	assert.ok(envelope.includes('<urn:username>a&amp;b@example.com</urn:username>'), 'username escaped');
	assert.ok(envelope.includes('<urn:password>p&lt;w&gt;dtok</urn:password>'), 'password + token escaped');
	assert.ok(envelope.includes('urn:partner.soap.sforce.com'), 'partner namespace');

	// Response parsing
	const parsed = parseLoginResponse(LOGIN_OK);
	assert.strictEqual(parsed.sessionId, '00Dxx0000001abc!AQ4AQH8exampleSessionId');
	assert.strictEqual(parsed.instanceUrl, 'https://na123.salesforce.com');
	assert.strictEqual(parsed.serverUrl, 'https://na123.salesforce.com/services/Soap/u/62.0/00Dxx0000001abc');

	// Fault parsing
	assert.strictEqual(
		extractSoapFault(LOGIN_FAULT),
		'INVALID_LOGIN: Invalid username, password, security token; or user locked out.',
	);
	assert.strictEqual(extractSoapFault(LOGIN_OK), undefined);

	// Normalizers
	assert.strictEqual(normalizeApiVersion('v63.0'), '63.0');
	assert.strictEqual(normalizeApiVersion(''), '62.0');
	assert.strictEqual(normalizeBaseUrl('https://login.salesforce.com///'), 'https://login.salesforce.com');

	// Header modes
	assert.deepStrictEqual(applySessionHeaders({}, 'SID', 'cookie'), { Cookie: 'sid=SID' });
	assert.deepStrictEqual(applySessionHeaders({}, 'SID', 'bearer'), { Authorization: 'Bearer SID' });
	assert.deepStrictEqual(applySessionHeaders({}, 'SID', 'both'), {
		Authorization: 'Bearer SID',
		Cookie: 'sid=SID',
	});
	assert.deepStrictEqual(applySessionHeaders({ 'X-Test': '1' }, 'SID', 'cookie'), {
		'X-Test': '1',
		Cookie: 'sid=SID',
	});

	// loginWithSoap happy path: verify request shape and full-response handling
	let captured;
	const session = await loginWithSoap(
		async (options) => {
			captured = options;
			return { body: LOGIN_OK, headers: {}, statusCode: 200, statusMessage: 'OK' };
		},
		{
			loginUrl: 'https://login.salesforce.com/',
			apiVersion: '62.0',
			username: 'user@example.com',
			password: 'secret',
			securityToken: 'token',
		},
	);
	assert.strictEqual(captured.url, 'https://login.salesforce.com/services/Soap/u/62.0');
	assert.strictEqual(captured.method, 'POST');
	assert.strictEqual(captured.headers.SOAPAction, 'login');
	assert.strictEqual(captured.json, false);
	assert.strictEqual(captured.returnFullResponse, true);
	assert.strictEqual(session.instanceUrl, 'https://na123.salesforce.com');

	// loginWithSoap: SOAP fault surfaced from a thrown axios-style error
	await assert.rejects(
		() =>
			loginWithSoap(
				async () => {
					const error = new Error('Request failed with status code 500');
					error.response = { data: LOGIN_FAULT };
					throw error;
				},
				{ loginUrl: 'https://login.salesforce.com', username: 'u', password: 'p' },
			),
		/INVALID_LOGIN/,
	);

	// loginWithSoap: missing session id
	await assert.rejects(
		() =>
			loginWithSoap(async () => ({ body: '<loginResponse/>', statusCode: 200 }), {
				loginUrl: 'https://login.salesforce.com',
				username: 'u',
				password: 'p',
			}),
		/no session ID was returned/,
	);

	// loginWithSoap: validation
	await assert.rejects(
		() => loginWithSoap(async () => ({}), { loginUrl: '', username: 'u', password: 'p' }),
		/login URL is required/,
	);

	console.log('All smoke tests passed.');
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
