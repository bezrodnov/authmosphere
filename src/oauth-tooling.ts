import * as qs from 'querystring';
import * as HttpStatus from 'http-status';
import fetch from 'node-fetch';
import * as querystring from 'querystring';

import {
  getFileDataAsObject,
  getBasicAuthHeaderValue,
  validateOAuthConfig,
  isAuthorizationCodeGrantConfig,
  isCredentialsDirConfig,
  isCredentialsUserConfig,
  isRefreshGrantConfig,
  extractUserCredentials,
  extractClientCredentials,
  isPasswordGrantNoCredentialsDir
} from './utils';

import {
  BodyParameters,
  CredentialsClientConfig,
  CredentialsUserConfig,
  Logger,
  OAuthConfig,
  OAuthGrantType,
  Token,
  GetTokenInfo
} from './types';

import { safeLogger } from './safe-logger';

const USER_JSON = 'user.json';
const CLIENT_JSON = 'client.json';
const OAUTH_CONTENT_TYPE = 'application/x-www-form-urlencoded';

/**
 * Returns URI to request authorization code with the given parameters.
 *
 * @param authorizationEndpoint - OAuth authorization endpoint
 * @param redirectUri - absolute URI specifying the endpoint the authorization code is responded
 * @param clientId - client id of requesting application
 * @param queryParams - optional set of key-value pairs which will be added as query parameters to the request
 * @returns {string}
 */
function createAuthCodeRequestUri(authorizationEndpoint: string,
                                  redirectUri: string,
                                  clientId: string,
                                  queryParams?: { [index: string]: string }): string {

  const extendedQueryParams = {
    'client_id': clientId,
    'redirect_uri': redirectUri,
    'response_type': 'code',
    ...queryParams
  };

  const queryString = qs.stringify(extendedQueryParams);
  // we are unescaping again since we did not escape before using querystring and we do not want to break anything
  const unescapedQueryString = qs.unescape(queryString);

  return `${authorizationEndpoint}?${unescapedQueryString}`;
}

/**
 * Makes a request to the `accessTokenEndpoint` with the given parameters.
 * Resolves with an access token in case of success.
 * Otherwise, rejects with error message.
 *
 * @param bodyObject
 * @param authorizationHeaderValue
 * @param accessTokenEndpoint
 * @param logger
 * @param queryParams
 * @returns {Promise<Token>}
 */
function requestAccessToken(bodyObject: BodyParameters,
                            authorizationHeaderValue: string,
                            accessTokenEndpoint: string,
                            logger: Logger,
                            queryParams?: { [index: string]: string }): Promise<Token> {

  const url = buildRequestAccessTokenUrl(accessTokenEndpoint, queryParams);

  const promise =
    fetch(url, {
      method: 'POST',
      body: querystring.stringify(bodyObject),
      headers: {
        'Authorization': authorizationHeaderValue,
        // eslint disables as content-type needs to be kebab-cased
        // eslint-disable-next-line @typescript-eslint/naming-convention
        'Content-Type': OAUTH_CONTENT_TYPE
      }
    })
      .then((response) => {

        const status = response.status;

        if (status !== HttpStatus.OK) {
          return response.json()
            .catch((error) => Promise.reject(error))
            .then((error: Error & { error?: Error, error_description?: string }) =>
              Promise.reject({
                // support error shape defined in https://tools.ietf.org/html/rfc6749#section-5.2
                // but do fall back if for some reason the definition is not satisfied
                error: (error && error.error) ? error.error : error,
                errorDescription: (error && error.error_description) ? error.error_description : undefined,
                status
              }));
        }

        logger.debug(`Successful request to ${accessTokenEndpoint}`);
        return response.json() as unknown as Token;
      })
      .catch((error: Error) => {
        logger.error(`Unsuccessful request to ${accessTokenEndpoint}`, error);
        return Promise.reject({
          message: `Error requesting access token from ${accessTokenEndpoint}`,
          error
        });
      });

  return promise;
}

/**
 * Build url string to request access token, optionally with given query parameters.
 *
 * @param accessTokenEndpoint
 * @param queryParams - key-value pairs which will be added as query parameters
 * @returns {string}
 */
function buildRequestAccessTokenUrl(accessTokenEndpoint: string, queryParams?: { [index: string]: string }): string {

  if (queryParams !== undefined) {
    const queryString = qs.stringify(queryParams);

    // we are unescaping again since we did not escape before using querystring and we do not want to break anything
    const unescapedQueryString = qs.unescape(queryString);

    return `${accessTokenEndpoint}?${unescapedQueryString}`;
  } else {
    return accessTokenEndpoint;
  }
}

/**
 * Makes a request to the `tokenInfoUrl` to validate the given `accessToken`.
 * In case of success resolves with a token.
 * Otherwise, rejects with an error message.
 *
 * Specify `T` to extend the type `Token`.
 *
 * @param tokenInfoUrl - OAuth endpoint for validating tokens
 * @param accessToken - access token to be validated
 * @param logger - optional logger
 *
 * @returns { Promise<Token<T>> }
 */
const getTokenInfo: GetTokenInfo =
  (tokenInfoUrl: string, accessToken: string, logger?: Logger): Promise<Token> => {

    const logOrNothing = safeLogger(logger);

    const promise = fetch(`${tokenInfoUrl}?access_token=${accessToken}`)
      .catch(() => Promise.reject({ errorDescription: 'tokenInfo endpoint not reachable ' }))
      .then((response) => {

        const status = response.status;

        return response.json()
          .then((data: Record<string | number | symbol, unknown>) => {

            if (status === HttpStatus.OK) {
              logOrNothing.debug(`Successful request to ${tokenInfoUrl}`);
              return data as Token;
            } else {
              logOrNothing.debug(`Unsuccessful request to ${tokenInfoUrl}, Http status: ${status}`);
              return Promise.reject({ status, data });
            }
          });
      })
      .catch((error: Error) => {

        logOrNothing.warn(`Error validating token via ${tokenInfoUrl}`);

        return Promise.reject({
          message: `Error validating token via ${tokenInfoUrl}`,
          error
        });
      });

    return promise;
  };

/**
 * Requests a token based on the given configuration (which specifies the grant type and corresponding parameters).
 *
 * Resolves with object of type `Token` (in case of success).
 * Otherwise, rejects with error message.
 *
 * @param options - OAuthConfig
 * @param logger - optional logger
 * @returns {Promise<T>}
 */
function getAccessToken(options: OAuthConfig, logger?: Logger): Promise<Token> {

  const logOrNothing = safeLogger(logger);

  validateOAuthConfig(options);

  return getCredentials(options)
    .then((credentials) => {

      let bodyParameters: BodyParameters;

      if (isCredentialsUserConfig(credentials)) {
        bodyParameters = {
          'grant_type': options.grantType,
          'username': credentials.applicationUsername,
          'password': credentials.applicationPassword
        };
      } else if (options.grantType === OAuthGrantType.CLIENT_CREDENTIALS_GRANT) {
        bodyParameters = {
          'grant_type': options.grantType
        };
      } else if (isAuthorizationCodeGrantConfig(options)) {
        bodyParameters = {
          'grant_type': options.grantType,
          'code': options.code,
          'redirect_uri': options.redirectUri
        };
      } else if (isRefreshGrantConfig(options)) {
        bodyParameters = {
          'grant_type': options.grantType,
          'refresh_token': options.refreshToken
        };
      } else {
        throw TypeError('invalid grantType');
      }

      if (options.scopes) {
        Object.assign(bodyParameters, {
          scope: options.scopes.join(' ')
        });
      }

      if (options.bodyParams) {
        Object.assign(bodyParameters, options.bodyParams);
      }
      const authorizationHeaderValue = getBasicAuthHeaderValue(credentials.clientId, credentials.clientSecret);

      return requestAccessToken(bodyParameters, authorizationHeaderValue,
        options.accessTokenEndpoint, logOrNothing, options.queryParams);
    });
}

const transformClientCredentials = (options: {[index: string]: string}): CredentialsClientConfig => ({
  clientId: options.client_id,
  clientSecret: options.client_secret
});

const transformUserCredentials = (options: {[index: string]: string}): CredentialsUserConfig => ({
  applicationUsername: options.application_username,
  applicationPassword: options.application_password
});

const getCredentials = (options: OAuthConfig) => {

  let getClientData;
  let getUserData;

  if (isCredentialsDirConfig(options)) {
    getClientData = getFileDataAsObject(options.credentialsDir, CLIENT_JSON)
      .then(transformClientCredentials);

    // For PASSWORD_CREDENTIALS_GRANT we need user credentials as well
    if (options.grantType === OAuthGrantType.PASSWORD_CREDENTIALS_GRANT) {
      getUserData = getFileDataAsObject(options.credentialsDir, USER_JSON)
        .then(transformUserCredentials);
    }
  } else {
    getClientData = Promise.resolve(extractClientCredentials(options));

    // For PASSWORD_CREDENTIALS_GRANT we need user credentials as well
    if (isPasswordGrantNoCredentialsDir(options)) {
      getUserData = Promise.resolve(extractUserCredentials(options));
    }
  }

  return Promise.all([getUserData, getClientData])
    .then(([userData, clientData]) =>
      ({ ...userData, ...clientData })
    );
};

export {
  getTokenInfo,
  getAccessToken,
  createAuthCodeRequestUri
};
