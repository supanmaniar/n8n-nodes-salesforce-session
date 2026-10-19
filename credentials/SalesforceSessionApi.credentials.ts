import type {
	IAuthenticate,
	ICredentialDataDecryptedObject,
	ICredentialType,
	IDataObject,
	IHttpRequestHelper,
	IHttpRequestOptions,
	INodeProperties,
} from 'n8n-workflow';

import {
	DEFAULT_API_VERSION,
	applySessionHeaders,
	loginWithSoap,
	normalizeApiVersion,
	normalizeBaseUrl,
} from '../nodes/SalesforceSession/session';

export class SalesforceSessionApi implements ICredentialType {
	name = 'salesforceSessionApi';

	displayName = 'Salesforce Session API';

	documentationUrl = 'https://developer.salesforce.com/docs/atlas.en-us.api.meta/api/sforce_api_calls_login.htm';

	icon = { light: 'file:salesforce.svg', dark: 'file:salesforce.dark.svg' } as const;

	properties: INodeProperties[] = [
		{
			displayName: 'Login URL',
			name: 'loginUrl',
			type: 'options',
			options: [
				{ name: 'Production (login.salesforce.com)', value: 'https://login.salesforce.com' },
				{ name: 'Sandbox (test.salesforce.com)', value: 'https://test.salesforce.com' },
				{ name: 'My Domain', value: 'custom' },
			],
			default: 'https://login.salesforce.com',
			description: 'Where to authenticate. Use "My Domain" for orgs that require it.',
		},
		{
			displayName: 'Custom Login URL',
			name: 'customLoginUrl',
			type: 'string',
			default: '',
			placeholder: 'https://mycompany.my.salesforce.com',
			displayOptions: {
				show: {
					loginUrl: ['custom'],
				},
			},
			description: 'Full URL of your My Domain login host',
		},
		{
			displayName: 'API Version',
			name: 'apiVersion',
			type: 'string',
			default: DEFAULT_API_VERSION,
			description: 'Salesforce API version used for the SOAP login call',
		},
		{
			displayName: 'Username',
			name: 'username',
			type: 'string',
			default: '',
			required: true,
		},
		{
			displayName: 'Password',
			name: 'password',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			required: true,
		},
		{
			displayName: 'Security Token',
			name: 'securityToken',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			description:
				'Appended to the password. Leave empty if your org has IP restrictions that exempt this host.',
		},
		{
			displayName: 'Send Session As',
			name: 'authMode',
			type: 'options',
			options: [
				{ name: 'Cookie (sid)', value: 'cookie' },
				{ name: 'Bearer Token', value: 'bearer' },
				{ name: 'Both', value: 'both' },
			],
			default: 'cookie',
			description:
				'How the session ID is attached to requests. "Cookie" mirrors a browser session; "Bearer" is the standard REST API form.',
		},
		{
			displayName: 'Session ID',
			name: 'sessionId',
			type: 'hidden',
			default: '',
			typeOptions: { expirable: true },
		},
		{
			displayName: 'Instance URL',
			name: 'instanceUrl',
			type: 'hidden',
			default: '',
		},
		{
			displayName: 'Server URL',
			name: 'serverUrl',
			type: 'hidden',
			default: '',
		},
		{
			displayName: 'Options',
			name: 'options',
			type: 'collection',
			placeholder: 'Add option',
			default: {},
			options: [
				{
					displayName: 'Timeout (Ms)',
					name: 'timeout',
					type: 'number',
					default: 30000,
					typeOptions: { minValue: 1 },
				},
				{
					displayName: 'Ignore SSL Issues',
					name: 'skipSslCertificateValidation',
					type: 'boolean',
					default: false,
					description: 'Whether to accept self-signed or otherwise invalid certificates',
				},
			],
		},
	];

	preAuthentication = async function (
		this: IHttpRequestHelper,
		credentials: ICredentialDataDecryptedObject,
	): Promise<IDataObject> {
		const options = (credentials.options ?? {}) as IDataObject;
		const loginUrl =
			credentials.loginUrl === 'custom'
				? normalizeBaseUrl(credentials.customLoginUrl as string)
				: normalizeBaseUrl(credentials.loginUrl as string);

		const session = await loginWithSoap(
			(requestOptions: IHttpRequestOptions) => this.helpers.httpRequest(requestOptions),
			{
				loginUrl,
				apiVersion: normalizeApiVersion(credentials.apiVersion as string),
				username: credentials.username as string,
				password: credentials.password as string,
				securityToken: credentials.securityToken as string,
				timeout: options.timeout as number | undefined,
				skipSslCertificateValidation: options.skipSslCertificateValidation as
					| boolean
					| undefined,
			},
		);

		return {
			sessionId: session.sessionId,
			instanceUrl: session.instanceUrl,
			serverUrl: session.serverUrl,
		};
	};

	authenticate: IAuthenticate = async (
		credentials: ICredentialDataDecryptedObject,
		requestOptions: IHttpRequestOptions,
	): Promise<IHttpRequestOptions> => {
		const sessionId = credentials.sessionId as string;
		if (!sessionId) {
			throw new Error('No Salesforce session available. Re-run the credential test to log in.');
		}

		requestOptions.headers = applySessionHeaders(
			(requestOptions.headers ?? {}) as IDataObject,
			sessionId,
			(credentials.authMode as string) ?? 'cookie',
		);

		return requestOptions;
	};
}
