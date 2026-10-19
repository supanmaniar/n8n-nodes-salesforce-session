import type {
	ICredentialDataDecryptedObject,
	ICredentialTestFunctions,
	ICredentialsDecrypted,
	IDataObject,
	IExecuteFunctions,
	IHttpRequestOptions,
	INodeCredentialTestResult,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
	JsonObject,
} from 'n8n-workflow';
import { NodeApiError, NodeConnectionTypes, NodeOperationError, jsonParse } from 'n8n-workflow';

import {
	SALESFORCE_CREDENTIAL_NAME,
	applySessionHeaders,
	loginWithSoap,
	normalizeApiVersion,
	normalizeBaseUrl,
} from './session';

interface LoginSettings {
	loginUrl: string;
	apiVersion: string;
	username: string;
	password: string;
	securityToken: string;
	timeout?: number;
	skipSslCertificateValidation?: boolean;
}

function readLoginSettings(credentials: ICredentialDataDecryptedObject): LoginSettings {
	const options = (credentials.options ?? {}) as IDataObject;
	const loginUrl =
		credentials.loginUrl === 'custom'
			? normalizeBaseUrl(credentials.customLoginUrl as string)
			: normalizeBaseUrl(credentials.loginUrl as string);

	return {
		loginUrl,
		apiVersion: normalizeApiVersion(credentials.apiVersion as string),
		username: credentials.username as string,
		password: credentials.password as string,
		securityToken: (credentials.securityToken as string) ?? '',
		timeout: options.timeout as number | undefined,
		skipSslCertificateValidation: options.skipSslCertificateValidation as boolean | undefined,
	};
}

function buildUrl(instanceUrl: string, apiVersion: string, endpoint: string): string {
	const trimmed = (endpoint ?? '').trim();
	if (/^https?:\/\//i.test(trimmed)) {
		return trimmed;
	}

	const path = trimmed.replace(/^\/+/, '');
	if (!path) {
		return `${instanceUrl}/services/data/v${apiVersion}/`;
	}
	if (path.startsWith('services/')) {
		return `${instanceUrl}/${path}`;
	}
	return `${instanceUrl}/services/data/v${apiVersion}/${path}`;
}

function parseJsonParameter(
	ctx: IExecuteFunctions,
	name: string,
	itemIndex: number,
): IDataObject {
	const raw = ctx.getNodeParameter(name, itemIndex, '{}');
	if (raw === '' || raw === undefined || raw === null) {
		return {};
	}
	if (typeof raw === 'object') {
		return raw as IDataObject;
	}
	try {
		const parsed = jsonParse(raw as string);
		return (parsed ?? {}) as IDataObject;
	} catch {
		throw new NodeOperationError(ctx.getNode(), `"${name}" must be valid JSON`, { itemIndex });
	}
}

function toJson(response: unknown): IDataObject {
	if (response === undefined || response === null) {
		return {};
	}
	if (typeof response === 'object') {
		return response as IDataObject;
	}
	return { data: response as string };
}

interface ResolvedSession {
	sessionId: string;
	instanceUrl: string;
}

/**
 * Returns a usable session, logging in only when the credential has not stored one yet.
 *
 * The probe request is what triggers n8n's `preAuthentication` hook, which performs the SOAP
 * login and persists the session onto the credential. No instance URL is known at that point,
 * so the probe target is irrelevant and its status is ignored. Once a session is stored, the
 * real request goes through `httpRequestWithAuthentication`, which refreshes on a `401`.
 */
async function ensureSession(
	ctx: IExecuteFunctions,
	settings: LoginSettings,
): Promise<ResolvedSession> {
	const credentials = await ctx.getCredentials(SALESFORCE_CREDENTIAL_NAME);
	const storedSessionId = (credentials.sessionId as string) ?? '';
	const storedInstanceUrl = normalizeBaseUrl(credentials.instanceUrl as string);

	if (storedSessionId && storedInstanceUrl) {
		return { sessionId: storedSessionId, instanceUrl: storedInstanceUrl };
	}

	await ctx.helpers.httpRequestWithAuthentication.call(ctx, SALESFORCE_CREDENTIAL_NAME, {
		url: `${settings.loginUrl}/services/data/v${settings.apiVersion}/`,
		method: 'GET',
		json: true,
		ignoreHttpStatusErrors: true,
		disableFollowRedirect: true,
		timeout: settings.timeout,
		skipSslCertificateValidation: settings.skipSslCertificateValidation,
	});

	const refreshed = await ctx.getCredentials(SALESFORCE_CREDENTIAL_NAME);
	const sessionId = (refreshed.sessionId as string) ?? '';
	const instanceUrl = normalizeBaseUrl(refreshed.instanceUrl as string);

	if (!sessionId || !instanceUrl) {
		throw new NodeOperationError(
			ctx.getNode(),
			'Salesforce login did not return a session. Check the credential and try again.',
		);
	}

	return { sessionId, instanceUrl };
}

export class SalesforceSession implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Salesforce Session',
		name: 'salesforceSession',
		icon: { light: 'file:salesforce.svg', dark: 'file:salesforce.dark.svg' },
		group: ['transform'],
		version: 1,
		usableAsTool: true,
		subtitle: '={{ $parameter["operation"] === "request" ? $parameter["method"] : "Session" }}',
		description:
			'Log in to Salesforce once and reuse the resulting session ID for REST API calls',
		defaults: {
			name: 'Salesforce Session',
		},
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		credentials: [
			{
				name: 'salesforceSessionApi',
				required: true,
				testedBy: 'salesforceSessionApiTest',
			},
		],
		properties: [
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				options: [
					{
						name: 'Get Session',
						value: 'getSession',
						description: 'Return the session ID and instance URL so other tools can reuse them',
						action: 'Get the current session',
					},
					{
						name: 'Request',
						value: 'request',
						description: 'Call the Salesforce REST API using the stored session',
						action: 'Make a REST API request',
					},
				],
				default: 'request',
			},
			{
				displayName: 'Method',
				name: 'method',
				type: 'options',
				options: [
					{ name: 'DELETE', value: 'DELETE' },
					{ name: 'GET', value: 'GET' },
					{ name: 'HEAD', value: 'HEAD' },
					{ name: 'PATCH', value: 'PATCH' },
					{ name: 'POST', value: 'POST' },
					{ name: 'PUT', value: 'PUT' },
				],
				default: 'GET',
				displayOptions: { show: { operation: ['request'] } },
			},
			{
				displayName: 'Endpoint',
				name: 'endpoint',
				type: 'string',
				default: '',
				placeholder: 'sobjects/Account',
				description:
					'Path relative to /services/data/v{version}/, or a full URL. Leave empty to call the API root.',
				displayOptions: { show: { operation: ['request'] } },
			},
			{
				displayName: 'Query Parameters',
				name: 'queryParameters',
				type: 'json',
				default: '{}',
				description: 'Key/value pairs appended to the URL as a query string',
				displayOptions: { show: { operation: ['request'] } },
			},
			{
				displayName: 'Body',
				name: 'body',
				type: 'json',
				default: '{}',
				description: 'JSON request body',
				displayOptions: {
					show: { operation: ['request'], method: ['POST', 'PUT', 'PATCH', 'DELETE'] },
				},
			},
			{
				displayName: 'Headers',
				name: 'headers',
				type: 'json',
				default: '{}',
				description: 'Additional request headers',
				displayOptions: { show: { operation: ['request'] } },
			},
			{
				displayName: 'Options',
				name: 'options',
				type: 'collection',
				placeholder: 'Add option',
				default: {},
				displayOptions: { show: { operation: ['request'] } },
				options: [
					{
						displayName: 'Full Response',
						name: 'fullResponse',
						type: 'boolean',
						default: false,
						description: 'Whether to return the status code and headers alongside the body',
					},
					{
						displayName: 'Ignore SSL Issues',
						name: 'skipSslCertificateValidation',
						type: 'boolean',
						default: false,
						description: 'Whether to accept self-signed or otherwise invalid certificates',
					},
					{
						displayName: 'Never Error',
						name: 'neverError',
						type: 'boolean',
						default: false,
						description: 'Whether to return non-2xx responses instead of failing the node',
					},
					{
						displayName: 'Timeout (Ms)',
						name: 'timeout',
						type: 'number',
						default: 30000,
						typeOptions: { minValue: 1 },
					},
				],
			},
		],
	};

	methods = {
		credentialTest: {
			async salesforceSessionApiTest(
				this: ICredentialTestFunctions,
				credential: ICredentialsDecrypted,
			): Promise<INodeCredentialTestResult> {
				const settings = readLoginSettings(credential.data ?? {});

				// ICredentialTestFunctions only exposes the legacy `request` helper, so the
				// deprecation rule cannot be satisfied here.
				// eslint-disable-next-line @n8n/community-nodes/no-deprecated-workflow-functions
				const request = this.helpers.request.bind(this.helpers);

				try {
					const session = await loginWithSoap(
						(requestOptions: IHttpRequestOptions) => request(requestOptions),
						settings,
					);

					await request({
						url: `${session.instanceUrl}/services/data/v${settings.apiVersion}/`,
						method: 'GET',
						headers: applySessionHeaders({}, session.sessionId, 'bearer'),
						json: true,
					});

					return {
						status: 'OK',
						message: `Logged in to ${session.instanceUrl}`,
					};
				} catch (error) {
					return {
						status: 'Error',
						message: (error as Error)?.message ?? 'Salesforce login failed',
					};
				}
			},
		},
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];
		const operation = this.getNodeParameter('operation', 0) as string;

		for (let i = 0; i < items.length; i++) {
			try {
				const credentials = await this.getCredentials(SALESFORCE_CREDENTIAL_NAME);
				const settings = readLoginSettings(credentials);
				const session = await ensureSession(this, settings);

				if (operation === 'getSession') {
					returnData.push({
						json: {
							sessionId: session.sessionId,
							instanceUrl: session.instanceUrl,
							apiVersion: settings.apiVersion,
							authMode: (credentials.authMode as string) ?? 'cookie',
							authorizationHeader: `Bearer ${session.sessionId}`,
							cookieHeader: `sid=${session.sessionId}`,
						},
						pairedItem: { item: i },
					});
					continue;
				}

				const method = this.getNodeParameter('method', i) as IHttpRequestOptions['method'];
				const endpoint = this.getNodeParameter('endpoint', i, '') as string;
				const options = this.getNodeParameter('options', i, {}) as IDataObject;

				const requestOptions: IHttpRequestOptions = {
					url: buildUrl(session.instanceUrl, settings.apiVersion, endpoint),
					method,
					headers: parseJsonParameter(this, 'headers', i),
					qs: parseJsonParameter(this, 'queryParameters', i),
					json: true,
					returnFullResponse: options.fullResponse === true,
					ignoreHttpStatusErrors: options.neverError === true,
					timeout: options.timeout as number | undefined,
					skipSslCertificateValidation: options.skipSslCertificateValidation as
						| boolean
						| undefined,
				};

				if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method ?? '')) {
					const body = parseJsonParameter(this, 'body', i);
					if (Object.keys(body).length > 0) {
						requestOptions.body = body;
					}
				}

				const response = await this.helpers.httpRequestWithAuthentication.call(
					this,
					SALESFORCE_CREDENTIAL_NAME,
					requestOptions,
				);

				returnData.push({
					json: toJson(response),
					pairedItem: { item: i },
				});
			} catch (error) {
				if (this.continueOnFail()) {
					returnData.push({
						json: { error: (error as Error)?.message },
						pairedItem: { item: i },
					});
					continue;
				}
				throw new NodeApiError(this.getNode(), error as JsonObject, { itemIndex: i });
			}
		}

		return [returnData];
	}
}
