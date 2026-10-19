import type { IDataObject, IHttpRequestOptions } from 'n8n-workflow';

export const SALESFORCE_CREDENTIAL_NAME = 'salesforceSessionApi';
export const DEFAULT_API_VERSION = '62.0';

export type HttpRequestFn = (options: IHttpRequestOptions) => Promise<unknown>;

export interface SalesforceLoginInput {
	loginUrl: string;
	apiVersion?: string;
	username: string;
	password: string;
	securityToken?: string;
	timeout?: number;
	skipSslCertificateValidation?: boolean;
}

export interface SalesforceSession {
	sessionId: string;
	instanceUrl: string;
	serverUrl: string;
}

export function normalizeBaseUrl(url: string | undefined): string {
	return (url ?? '').trim().replace(/\/+$/, '');
}

export function normalizeApiVersion(version: string | undefined): string {
	const trimmed = (version ?? '').trim().replace(/^v/i, '');
	return trimmed || DEFAULT_API_VERSION;
}

export function escapeXml(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&apos;');
}

function decodeXmlEntities(value: string): string {
	return value
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)))
		.replace(/&amp;/g, '&');
}

export function buildLoginEnvelope(
	username: string,
	password: string,
	securityToken = '',
): string {
	return `<?xml version="1.0" encoding="utf-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:urn="urn:partner.soap.sforce.com">
	<soapenv:Body>
		<urn:login>
			<urn:username>${escapeXml(username)}</urn:username>
			<urn:password>${escapeXml(`${password}${securityToken}`)}</urn:password>
		</urn:login>
	</soapenv:Body>
</soapenv:Envelope>`;
}

export function extractSoapFault(body: string): string | undefined {
	const match = /<(?:\w+:)?faultstring>([\s\S]*?)<\/(?:\w+:)?faultstring>/i.exec(body);
	return match ? decodeXmlEntities(match[1].trim()) : undefined;
}

export function parseLoginResponse(body: string): SalesforceSession | undefined {
	const sessionId = /<(?:\w+:)?sessionId>([^<]+)<\/(?:\w+:)?sessionId>/i.exec(body)?.[1]?.trim();
	const serverUrl = /<(?:\w+:)?serverUrl>([^<]+)<\/(?:\w+:)?serverUrl>/i.exec(body)?.[1]?.trim();

	if (!sessionId || !serverUrl) {
		return undefined;
	}

	let instanceUrl: string;
	try {
		instanceUrl = new URL(serverUrl).origin;
	} catch {
		return undefined;
	}

	return { sessionId, instanceUrl, serverUrl };
}

function bodyToString(body: unknown): string {
	if (typeof body === 'string') {
		return body;
	}
	if (Buffer.isBuffer(body)) {
		return body.toString('utf8');
	}
	if (body === undefined || body === null) {
		return '';
	}
	return String(body);
}

function extractResponseBody(response: unknown): string {
	if (
		response !== null &&
		typeof response === 'object' &&
		'body' in response &&
		'statusCode' in response
	) {
		return bodyToString((response as { body: unknown }).body);
	}
	return bodyToString(response);
}

export async function loginWithSoap(
	httpRequest: HttpRequestFn,
	input: SalesforceLoginInput,
): Promise<SalesforceSession> {
	const baseUrl = normalizeBaseUrl(input.loginUrl);
	if (!baseUrl) {
		throw new Error('Salesforce login URL is required.');
	}
	if (!input.username) {
		throw new Error('Salesforce username is required.');
	}
	if (!input.password) {
		throw new Error('Salesforce password is required.');
	}

	const apiVersion = normalizeApiVersion(input.apiVersion);
	const requestOptions = {
		url: `${baseUrl}/services/Soap/u/${apiVersion}`,
		method: 'POST',
		headers: {
			'Content-Type': 'text/xml; charset=utf-8',
			SOAPAction: 'login',
		},
		body: buildLoginEnvelope(input.username, input.password, input.securityToken ?? ''),
		json: false,
		returnFullResponse: true,
		timeout: input.timeout,
		skipSslCertificateValidation: input.skipSslCertificateValidation,
	} as IHttpRequestOptions;

	let response: unknown;
	let requestError: unknown;
	try {
		response = await httpRequest(requestOptions);
	} catch (error) {
		requestError = error;
	}

	if (requestError !== undefined) {
		const errorResponse = (requestError as { response?: { data?: unknown; body?: unknown } })
			?.response;
		const fault = extractSoapFault(bodyToString(errorResponse?.data ?? errorResponse?.body));
		throw new Error(fault ?? (requestError as Error)?.message ?? 'Salesforce login failed.');
	}

	const rawBody = extractResponseBody(response);
	const fault = extractSoapFault(rawBody);
	if (fault) {
		throw new Error(fault);
	}

	const session = parseLoginResponse(rawBody);
	if (!session) {
		throw new Error('Salesforce login succeeded but no session ID was returned.');
	}

	return session;
}

export function applySessionHeaders(
	headers: IDataObject,
	sessionId: string,
	mode: string,
): IDataObject {
	const result: IDataObject = { ...headers };

	if (mode === 'bearer' || mode === 'both') {
		result.Authorization = `Bearer ${sessionId}`;
	}
	if (mode === 'cookie' || mode === 'both') {
		result.Cookie = `sid=${sessionId}`;
	}

	return result;
}
