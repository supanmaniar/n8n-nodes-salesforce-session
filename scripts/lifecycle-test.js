// Simulates n8n's credential lifecycle (preAuthentication -> persist -> authenticate ->
// 401 retry) against the built credential, mirroring packages/cli/src/credentials-helper.ts
// and n8n-core's httpRequestWithAuthentication.
const assert = require('node:assert');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const { SalesforceSessionApi } = require(path.join(ROOT, 'dist/credentials/SalesforceSessionApi.credentials.js'));

const LOGIN_XML = (sid, host) =>
	`<loginResponse><result><sessionId>${sid}</sessionId><serverUrl>https://${host}/services/Soap/u/62.0/00D</serverUrl></result></loginResponse>`;

function createHarness({ loginResponses, apiHandler }) {
	const credential = new SalesforceSessionApi();
	const stored = {
		loginUrl: 'https://login.salesforce.com',
		apiVersion: '62.0',
		username: 'u@example.com',
		password: 'pw',
		securityToken: 'tok',
		authMode: 'cookie',
		sessionId: '',
		instanceUrl: '',
		serverUrl: '',
		options: {},
	};

	let loginIndex = 0;
	const logins = [];
	const apiCalls = [];

	const helpers = {
		httpRequest: async (options) => {
			logins.push(options);
			const [sid, host] = loginResponses[Math.min(loginIndex++, loginResponses.length - 1)];
			return { body: LOGIN_XML(sid, host), statusCode: 200, headers: {} };
		},
	};

	// Mirrors CredentialsHelper.preAuthentication
	async function preAuthentication(credentials, credentialsExpired) {
		const expirable = credential.properties.find(
			(p) => p.type === 'hidden' && p.typeOptions?.expirable === true,
		);
		if (!expirable) return undefined;
		if (credentials[expirable.name] !== '' && !credentialsExpired) return undefined;

		const output = await credential.preAuthentication.call({ helpers }, credentials);
		if (output[expirable.name] === undefined) return undefined;
		Object.assign(stored, output);
		return Object.assign(credentials, output);
	}

	// Mirrors httpRequestWithAuthentication
	async function httpRequestWithAuthentication(requestOptions) {
		const credentials = { ...stored };
		const data = await preAuthentication(credentials, false);
		if (data) Object.assign(credentials, data);

		let options = await credential.authenticate(credentials, { ...requestOptions });

		try {
			return await apiHandler(options, apiCalls);
		} catch (error) {
			if (error.response?.status !== 401) throw error;
			const refreshed = await preAuthentication(credentials, true);
			if (refreshed) Object.assign(credentials, refreshed);
			options = await credential.authenticate(credentials, { ...requestOptions });
			return await apiHandler(options, apiCalls);
		}
	}

	return { credential, stored, logins, apiCalls, helpers, httpRequestWithAuthentication };
}

(async () => {
	// 1. First call logs in once, persists the session, and sends the sid cookie.
	let harness = createHarness({
		loginResponses: [['SID-1', 'na1.salesforce.com']],
		apiHandler: async (options, calls) => {
			calls.push(options);
			return [{ version: '62.0' }];
		},
	});

	await harness.httpRequestWithAuthentication({
		url: 'https://login.salesforce.com/services/data/v62.0/',
		method: 'GET',
		json: true,
		ignoreHttpStatusErrors: true,
	});

	assert.strictEqual(harness.logins.length, 1, 'one SOAP login');
	assert.strictEqual(harness.stored.sessionId, 'SID-1', 'session persisted');
	assert.strictEqual(harness.stored.instanceUrl, 'https://na1.salesforce.com', 'instance URL persisted');
	assert.strictEqual(harness.stored.serverUrl, 'https://na1.salesforce.com/services/Soap/u/62.0/00D');
	assert.strictEqual(harness.apiCalls[0].headers.Cookie, 'sid=SID-1', 'cookie attached');

	// 2. Second call reuses the stored session: no new login.
	await harness.httpRequestWithAuthentication({
		url: 'https://na1.salesforce.com/services/data/v62.0/sobjects/Account',
		method: 'GET',
		json: true,
	});
	assert.strictEqual(harness.logins.length, 1, 'no second login');
	assert.strictEqual(harness.apiCalls[1].headers.Cookie, 'sid=SID-1');

	// 3. A 401 forces exactly one re-login and one retry with the new session.
	let attempts = 0;
	harness = createHarness({
		loginResponses: [
			['SID-OLD', 'na1.salesforce.com'],
			['SID-NEW', 'na1.salesforce.com'],
		],
		apiHandler: async (options, calls) => {
			calls.push(options);
			attempts++;
			if (options.headers.Cookie === 'sid=SID-OLD') {
				const error = new Error('401');
				error.response = { status: 401 };
				throw error;
			}
			return { ok: true };
		},
	});

	const result = await harness.httpRequestWithAuthentication({
		url: 'https://na1.salesforce.com/services/data/v62.0/sobjects/Account',
		method: 'GET',
		json: true,
	});

	assert.strictEqual(harness.logins.length, 2, 're-login on 401');
	assert.strictEqual(attempts, 2, 'retried once');
	assert.strictEqual(harness.stored.sessionId, 'SID-NEW', 'new session persisted');
	assert.strictEqual(harness.apiCalls[1].headers.Cookie, 'sid=SID-NEW', 'retry used new session');
	assert.deepStrictEqual(result, { ok: true });

	// 4. Bearer mode attaches an Authorization header instead of a cookie.
	harness = createHarness({
		loginResponses: [['SID-B', 'eu12.salesforce.com']],
		apiHandler: async (options, calls) => {
			calls.push(options);
			return {};
		},
	});
	harness.stored.authMode = 'bearer';
	await harness.httpRequestWithAuthentication({
		url: 'https://login.salesforce.com/services/data/v62.0/',
		method: 'GET',
		json: true,
		ignoreHttpStatusErrors: true,
	});
	assert.strictEqual(harness.apiCalls[0].headers.Authorization, 'Bearer SID-B');
	assert.strictEqual(harness.apiCalls[0].headers.Cookie, undefined);

	// 5. Both mode attaches both.
	harness = createHarness({
		loginResponses: [['SID-BOTH', 'eu12.salesforce.com']],
		apiHandler: async (options, calls) => {
			calls.push(options);
			return {};
		},
	});
	harness.stored.authMode = 'both';
	await harness.httpRequestWithAuthentication({
		url: 'https://login.salesforce.com/services/data/v62.0/',
		method: 'GET',
		json: true,
		ignoreHttpStatusErrors: true,
	});
	assert.strictEqual(harness.apiCalls[0].headers.Authorization, 'Bearer SID-BOTH');
	assert.strictEqual(harness.apiCalls[0].headers.Cookie, 'sid=SID-BOTH');

	// 6. A failed login surfaces the SOAP fault and persists nothing.
	harness = createHarness({
		loginResponses: [['SID-X', 'na1.salesforce.com']],
		apiHandler: async () => ({}),
	});
	harness.helpers.httpRequest = async () => {
		const error = new Error('Request failed with status code 500');
		error.response = {
			data: '<soapenv:Fault><faultstring>INVALID_LOGIN: Invalid username</faultstring></soapenv:Fault>',
		};
		throw error;
	};
	await assert.rejects(
		() =>
			harness.httpRequestWithAuthentication({
				url: 'https://login.salesforce.com/services/data/v62.0/',
				method: 'GET',
				json: true,
			}),
		/INVALID_LOGIN/,
	);
	assert.strictEqual(harness.stored.sessionId, '', 'nothing persisted on failure');

	console.log('Lifecycle tests passed.');
})().catch((error) => {
	console.error(error);
	process.exit(1);
});
