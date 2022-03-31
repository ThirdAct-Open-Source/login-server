import {RequestHandler, Router} from 'express';
import config from "../Config";
import User, {generateUsername, getAccessTokensForScope, IUser, UNAUTHROIZED_USERNAME} from "../User";
import {Document} from "mongoose";
import mongoose, {redis} from "../Database";
import RPCServer from "../RPC";
import Client, {getIdentityEntityByAccessToken, IClient} from "../Auth/Client";
import {nanoid} from 'nanoid';
import fetch, {RequestInit} from 'node-fetch';
import * as URL from 'url';
import {
    AccessToken,
    AccessTokenSchema,
    checkScopePermission,
    fromFormalToken,
    IAccessToken,
    IFormalAccessToken,
    IScopeContext,
    toFormalToken
} from "../Auth/AccessToken";
import ApplicationContext from "../ApplicationContext";
import {IClientRole} from "@znetstar/attic-common/lib/IClient";
import * as _ from 'lodash';
import {ScopeAccessTokenPair, TokenTypes} from "@znetstar/attic-common/lib/IAccessToken";
import {
    ClientOrProviderDoesNotHaveAccessToGroupError,
    CouldNotFindTokenForScopeError,
    CouldNotLocateStateError,
    ErrorGettingTokenFromProviderError,
    InvalidAccessTokenError,
    InvalidClientOrProviderError,
    InvalidGrantTypeError,
    InvalidResponseTypeError,
    MalformattedTokenRequestError,
    NotAuthorizedToUseScopesError,
    ProviderDoesNotAllowRegistrationError
} from "@znetstar/attic-common/lib/Error/AccessToken";
import {asyncMiddleware} from "./Common";
import {CouldNotLocateIdentityError, CouldNotLocateUserError} from '@znetstar/attic-common/lib/Error/Auth';
import {OAuthTokenForm, OAuthTokenRequest} from "@znetstar/attic-common/lib/IRPC";

export const AuthMiddleware = Router();

export const StaticScopes = new Set(...Object.keys(RPCServer.methods).map(str => `rpc.${str}`));
export function registerStaticScope(scope: string) { StaticScopes.add(scope); }

let unauthorizedUser: IUser;

AuthMiddleware.use((req: any, res, next) => {
     req.scopeContext = { } as IScopeContext;
     next();
})

export function restrictScopeMiddleware(scope: string): RequestHandler {

    return function (req: any, res: any, next: any) {
        (async () => {
            if (!req.user) {
                throw new ((global as any).ApplicationContext.errors.getErrorByName('CouldNotLocateUserError') as any)();
            } else {
                const context = req.scopeContext as IScopeContext;
                let user: IUser = context.user = req.user;

                for await (let tknResponse of await getAccessTokensForScope(user._id, scope)) {
                    let scopeTokenPair: ScopeAccessTokenPair = tknResponse;
                    let accessToken: IAccessToken&Document|null = _.get(scopeTokenPair, '1') as IAccessToken&Document|null;
                    if (accessToken) {
                        context.currentScopeAccessToken = accessToken;


                        return;
                    }
                }
                throw new CouldNotFindTokenForScopeError([ scope, null ]);
            }
        })().then(() => next()).catch(err => next(err));
    }
}

export function restrictOauth(fn: string) {
    return function (req: any, res: any, next: any) {
        return restrictScopeMiddleware(`auth.${req.params.provider}.${fn}`)(req ,res, next);
    }
}

AuthMiddleware.use(asyncMiddleware(async function (req: any, res: any, next: any) {
    const context = req.scopeContext as IScopeContext;
    let tempToken = req.query.atticAccessToken || req.session.atticAccessToken;
    if (req.headers.authorization || tempToken) {
        let tokenType, tokenStr;
        if (tempToken) {
            tokenType = 'bearer';
            tokenStr = tempToken;
        } else {
            let [_tokenType, _tokenStr] = req.headers.authorization.split(' ');
            tokenType = _tokenType.toLowerCase();
            tokenStr = _tokenStr;
        }

        let token = context.accessToken = await mongoose.models.AccessToken.findOne( { tokenType, token: tokenStr } ).exec();
        if (token) {
            let tDate = new Date(((new Date()).getTime() + ( 60e3 * 60 )));
            if (tempToken && ( !token.expiresAt || token.expiresAt.getTime() > tDate.getTime())) {
                token.expiresAt = tDate;
                req.session.atticAccessToken = tempToken;
            }
            req.user = context.user = await mongoose.models.User.findById(token.user);
            if (token.isModified) await token.save();
        } else if (!tempToken) {
            throw new ((global as any).ApplicationContext.errors.getErrorByName('InvalidAccessTokenError') as any)();
        }
    }

    if (!req.user) {
        req.user = context.user = unauthorizedUser = req.user || unauthorizedUser || await mongoose.models.User.findOne({ username: UNAUTHROIZED_USERNAME }).exec();

        if (!req.user) {
            throw new ((global as any).ApplicationContext.errors.getErrorByName('CouldNotLocateUserError') as any)();
        }

        context.accessToken = { scope: req.user.scope.slice(0) } as any;
    }

    return true;
}));




export function getAccessTokenForm(req: OAuthTokenRequest): OAuthTokenForm {
    let getField = (f: string) => _.get(req, f);
    let grantType = getField('grant_type');
    let clientId = getField('client_id');
    let clientSecret = getField('client_secret');
    let redirectUri = getField('redirect_uri');
    let originalState = getField('state');
    let code = [].concat(getField('code'))[0];
    let refreshTokenCode = getField('refresh_token');
    let username = getField('username');
    let password = getField('password');
    let scope = Array.isArray(getField('scope')) ? getField('scope') : (getField('scope') || '').split(' ');

    return {
        grantType,
        clientSecret,
        clientId,
        redirectUri,
        originalState,
        code,
        refreshTokenCode,
        username,
        password,
        scope
    }
}

ApplicationContext.on('Web.AuthMiddleware.getAccessToken.grantTypes.authorization_code', async function (client: IClient&Document, req: OAuthTokenRequest) {
    let accessToken: IAccessToken&Document,
        refreshToken: IAccessToken&Document;
    let {
        password,
        username,
        refreshTokenCode,
        originalState,
        redirectUri,
        clientId,
        clientSecret,
        grantType,
        code
    } = getAccessTokenForm(req);
  ApplicationContext.logs.silly(`AuthMiddleware.getAccessToken.grantTypes.authorization_code.start`, {
    request: req
  });

    if (!code) {
        throw new ((global as any).ApplicationContext.errors.getErrorByName('MalformattedTokenRequestError') as any)();
    }
    let stateKey = `auth.token.${code}`;
    let state = await redis.hgetall(stateKey);
    if (!Object.keys(state).length || !state) {
        throw new ((global as any).ApplicationContext.errors.getErrorByName('CouldNotLocateStateError') as any)();
    }
    await redis.del(stateKey);

    let user = await User.findById(state.user).exec();

    if (!user || state.client !== client.id || client.redirectUri !== redirectUri) {
        throw new ((global as any).ApplicationContext.errors.getErrorByName('InvalidClientOrProviderError') as any)();
        return ;
    }


    let scopes = checkScopePermission((state.scope || '').split(' '), client, user);

    accessToken = new AccessToken({
        tokenType: 'bearer',
        token: nanoid(),
        scope: scopes,
        client: client._id,
        clientRole:  IClientRole.consumer,
        clientName: client.name,
        redirectUri: client.redirectUri,
        user: user
    })

    refreshToken = await AccessToken.findOne({
        client,
        user,
        scope: scopes,
        tokenType: TokenTypes.RefreshToken
    }).exec();

    if (!refreshToken) {
        refreshToken = new AccessToken({
            tokenType: 'refresh_token',
            token: nanoid(),
            linkedToken: accessToken._id,
            scope: scopes,
            client: client._id,
            clientRole: IClientRole.consumer,
            clientName: client.name,
            redirectUri: client.redirectUri,
            user: user
        });
    }

    accessToken.linkedToken = refreshToken._id;
    const resp = {
      accessToken,
      refreshToken
    };
  ApplicationContext.logs.silly(`AuthMiddleware.getAccessToken.grantTypes.authorization_code.complete`, {
    request: req,
    response: resp
  });
    return resp;
});

async function getAccessToken (form: OAuthTokenRequest): Promise<IFormalAccessToken> {
  const informalForm = getAccessTokenForm(form);
    let {
        password,
        username,
        refreshTokenCode,
        originalState,
        redirectUri,
        clientId,
        clientSecret,
        grantType,
        code
    } = informalForm;

    ApplicationContext.logs.silly(`AuthMiddleware.getAccessToken.start`, {
       request: form
    });

    const enforceRedirectUri = !config.allowGetTokenWithNoRedirectUri || !config.allowGetTokenWithNoRedirectUri.includes(grantType);
    let grantEvent = `Web.AuthMiddleware.getAccessToken.grantTypes.${grantType || ''}`;

    if (!grantType || !clientId || !clientSecret || (enforceRedirectUri && !redirectUri) || !(ApplicationContext).eventNames().includes(grantEvent)) {
        throw new ((global as any).ApplicationContext.errors.getErrorByName('MalformattedTokenRequestError') as any)();
    }

    const q: any = {
      clientId,
      clientSecret,
      role: { $in: [ 'consumer' ] }
    };

    if (enforceRedirectUri) {
      q.redirectUri = redirectUri;
    }

    let client = await Client.findOne(q).exec();


    if (!client) {
        throw new ((global as any).ApplicationContext.errors.getErrorByName('InvalidClientOrProviderError') as any)();
    }

    let output = await ApplicationContext.triggerHookSingle<{ accessToken: IAccessToken&Document, refreshToken?: IAccessToken&Document  }>(grantEvent, client, form);
    if (!output) {
        throw new InvalidGrantTypeError(`Invalid Grant Type ${grantType}`);
    }

    let { accessToken, refreshToken } = output;
    if (!accessToken) {
        throw new InvalidGrantTypeError(`Invalid Grant Type ${grantType}`);
    }

    await accessToken.save();
    if (refreshToken)
        await refreshToken.save();

    const formalAccessToken = await toFormalToken(accessToken);

  ApplicationContext.logs.silly(`AuthMiddleware.getAccessToken.complete`, {
    request: form,
    response: formalAccessToken
  });

    return formalAccessToken;
}

RPCServer.methods.getAccessToken = getAccessToken;
RPCServer.methods.getAccessTokenForm = async (form: OAuthTokenRequest) => getAccessTokenForm(form);

ApplicationContext.on('Web.AuthMiddleware.getAccessToken.grantTypes.refresh_token', async function (client: IClient&Document, req: OAuthTokenRequest) {
    let accessToken: IAccessToken&Document,
        refreshToken: IAccessToken&Document;
    let {
        password,
        username,
        refreshTokenCode,
        originalState,
        redirectUri,
        clientId,
        clientSecret,
        grantType,
        code,
        scope
    } = getAccessTokenForm(req);

    if (!refreshTokenCode) {
        throw new ((global as any).ApplicationContext.errors.getErrorByName('MalformattedTokenRequestError') as any)();
    }

    refreshToken = await ( AccessToken.findOne({
        tokenType: TokenTypes.RefreshToken,
        client: client._id,
        clientRole: IClientRole.consumer,
        token: refreshTokenCode
    })).exec();

    if (!refreshToken)
        throw new CouldNotFindTokenForScopeError([ 'rpc.getAccessToken', null ]);

    await refreshToken.populate('user client').execPopulate();
    checkScopePermission(refreshToken.scope, refreshToken.client, refreshToken.user);

    if (refreshToken) {
        accessToken = await AccessTokenSchema.methods.accessTokenFromRefresh.call(refreshToken);
    }

    return {
        accessToken,
        refreshToken
    }
});

ApplicationContext.on('Web.AuthMiddleware.getAccessToken.grantTypes.password', async function (client: IClient&Document, req: OAuthTokenRequest, user?: IUser&Document) {
    let accessToken: IAccessToken&Document,
        refreshToken: IAccessToken&Document;
    let {
        password,
        username,
        scope
    } = getAccessTokenForm(req);
  ApplicationContext.logs.silly(`AuthMiddleware.getAccessToken.grantTypes.password.start`, {
    request: req
  });

    if (!user) {
        if (!password || !username) {
            throw new ((global as any).ApplicationContext.errors.getErrorByName('MalformattedTokenRequestError') as any)();
        }

        user = await User.findOne({
            username
        });

        if (!user || !await user.checkPassword(password)) {
            throw new ((global as any).ApplicationContext.errors.getErrorByName('CouldNotLocateUserError') as any)();
        }
    }

    let scopes = checkScopePermission([].concat(scope), client, user);

    if (user.isNew) await user.save();

    accessToken = new AccessToken({
        tokenType: 'bearer',
        token: nanoid(),
        scope: scopes,
        client: client._id,
        clientRole:  IClientRole.consumer,
        clientName: client.name,
        redirectUri: client.redirectUri,
        user: user
    })


    refreshToken = await AccessToken.findOne({
        client,
        user,
        scope: scopes,
        tokenType: TokenTypes.RefreshToken
    }).exec();

    if (!refreshToken) {
        refreshToken = new AccessToken({
            tokenType: 'refresh_token',
            token: nanoid(),
            linkedToken: accessToken._id,
            scope: scopes,
            client: client._id,
            clientRole: IClientRole.consumer,
            clientName: client.name,
            redirectUri: client.redirectUri,
            user: user
        });
    }

    accessToken.linkedToken = refreshToken._id;

    const resp = {
      accessToken,
      refreshToken
    };
  ApplicationContext.logs.silly(`AuthMiddleware.getAccessToken.grantTypes.password.complete`, {
    request: req,
    response: resp
  });
    return resp;
});

ApplicationContext.on('Web.AuthMiddleware.getAccessToken.grantTypes.client_credentials', async function (client: IClient&Document, req: OAuthTokenRequest) {
    let accessToken: IAccessToken&Document,
        refreshToken: IAccessToken&Document;
    let {
        clientId,
        clientSecret,
        scope,
        username
    } = getAccessTokenForm(req);

  ApplicationContext.logs.silly(`AuthMiddleware.getAccessToken.grantTypes.client_credentials.start`, {
    request: req
  });

    if (!clientSecret || !clientId || !scope || !scope.length) {
        throw new ((global as any).ApplicationContext.errors.getErrorByName('MalformattedTokenRequestError') as any)();
    }

    if (!client)
        throw new ((global as any).ApplicationContext.errors.getErrorByName('InvalidClientOrProviderError') as any)();

    let groups = client.scope.map((s: string) => s.match(/^group\.(.*)/)).filter(Boolean).map((g: string[]) => g[1]);

    let user = await User.findOne({
        username: username ? username : (!client.defaultUser ? client.defaultUsername : (client.defaultUser as IUser).username),
        groups: {
            $in: groups
        }
    }).exec();

    if (!user) {
        throw new ((global as any).ApplicationContext.errors.getErrorByName('ClientOrProviderDoesNotHaveAccessToGroupError') as any)();
    }

    let scopes = checkScopePermission([].concat(scope), client, user);


    accessToken = new AccessToken({
        tokenType: 'bearer',
        token: nanoid(),
        scope: scopes,
        client: client._id,
        clientRole:  IClientRole.consumer,
        clientName: client.name,
        redirectUri: client.redirectUri,
        user: user
    })

    refreshToken = await AccessToken.findOne({
        client,
        user,
        scope: scopes,
        tokenType: TokenTypes.RefreshToken
    }).exec();

    if (!refreshToken) {
        refreshToken = new AccessToken({
            tokenType: 'refresh_token',
            token: nanoid(),
            linkedToken: accessToken._id,
            scope: scopes,
            client: client._id,
            clientRole: IClientRole.consumer,
            clientName: client.name,
            redirectUri: client.redirectUri,
            user: user
        });
    }

    accessToken.linkedToken = refreshToken._id;

    const resp = {
      accessToken,
      refreshToken
    };
  ApplicationContext.logs.silly(`AuthMiddleware.getAccessToken.grantTypes.client_credentials.complete`, {
    request: req,
    response: resp
  });
    return resp;
});


AuthMiddleware.post('/auth/token', require('body-parser').urlencoded({ extended: true, type: 'application/x-www-form-urlencoded' }), require('body-parser').json({ type: 'application/json' }),restrictScopeMiddleware('auth.token'), asyncMiddleware(async function (req: any, res: any, next: any) {
    let form = {
        ...req.query,
        ...req.body
    };

    let formalToken = await getAccessToken(form);
    res.status(200).send(formalToken);
}));

AuthMiddleware.get('/auth/:provider/authorize', restrictScopeMiddleware('auth.authorize'), asyncMiddleware(async function (req: any, res: any, next: any) {
  try {
    ApplicationContext.logs.silly({
      method: `AuthMiddleware.auth.${req.params.provider}.authorize.start`,
      params: [
        req.query
      ]
    });

    let state: string;
    let originalState: string;
    if (req.query.code && req.query.state)
      state = [].concat(req.query.state)[0];
    else if (req.query.state) {
      originalState = req.query.state;
      req.query.state = void (0);
    }

    if (!req.query.state) {
      state = nanoid();
    }

    let stateKeyBase = `auth.${req.params.provider}.authorize.`;
    let stateKey = stateKeyBase + state;

    if (
      req.query.code
    ) {
      let existingState: any = req.query.state && await redis.hgetall(stateKey);

      ApplicationContext.logs.silly({
        method: `AuthMiddleware.auth.${req.params.provider}.authorize.existingState`,
        params: [
          {stateKey, existingState}
        ]
      });

      if (typeof (existingState) === 'object' && existingState !== null && !Object.keys(existingState).length)
        existingState = void (0);

      if (!existingState) {
        if (req.query.response_type !== 'code') {
          throw new ((global as any).ApplicationContext.errors.getErrorByName('InvalidResponseTypeError') as any)();
        } else {
          throw new ((global as any).ApplicationContext.errors.getErrorByName('CouldNotLocateStateError') as any)();
        }
      } else {
        await redis.del(stateKey);
        let [client, provider]: [IClient & Document, IClient & Document] = await Promise.all([
          Client.findById(existingState.client).exec(),
          Client.findById(existingState.provider).exec()
        ]);

        if (!client || !provider) {
          throw new ((global as any).ApplicationContext.errors.getErrorByName('InvalidClientOrProviderError') as any)();
          return;
        }

        let q = {
          grant_type: 'authorization_code',
          code: req.query.code,
          redirect_uri: existingState.redirectUri,
          client_id: provider.clientId,
          client_secret: provider.clientSecret
        }

        q = provider.applyUriSubstitutions(q);

        let tokenUri: any = URL.parse(provider.tokenUri, true);
        // tokenUri.query = q;
        tokenUri = URL.format(tokenUri);

        const params = new URL.URLSearchParams();

        for (let k in q) params.append(k, (q as any)[k]);

        let fetchOpts: any = {
          method: 'POST',
          headers: {'Content-Type': 'application/x-www-urlencoded'}
        };
        let hookResp: any = await ApplicationContext.triggerHookSingle(`AuthMiddleware.auth.${provider.name}.authorize.token`, {
          params,
          req,
          provider,
          fetchOpts,
          state,
          tokenUri
        });

        const tokenUriCloned = typeof (hookResp) === 'string' ? hookResp : hookResp?.tokenUri;
        const newOpts = hookResp?.fetchOpts;

        if (newOpts)
          fetchOpts = newOpts;
        else
          fetchOpts.body = params;

        // let qq: any = {};
        // for (let [k,v] of params.entries()) qq[k] = v;
        //
        // fetchOpts.body =  require('qs').stringify(qq);

        let tokenResp = await fetch(tokenUriCloned || tokenUri, fetchOpts);

        if (tokenResp.status !== 200) {
          const resp = await tokenResp.json();
          ApplicationContext.logs.error({
            method: `AuthMiddleware.auth.${req.params.provider}.authorize.token`,
            params: [
              {resp}
            ]
          });
          throw new ErrorGettingTokenFromProviderError(resp);
        }

        let formalToken: IFormalAccessToken = await tokenResp.json();
        let {accessToken, refreshToken} = await fromFormalToken(formalToken, null, provider, IClientRole.provider);
        let identity = await getIdentityEntityByAccessToken(accessToken);

        if (!identity) {
          throw new ((global as any).ApplicationContext.errors.getErrorByName('CouldNotLocateIdentityError') as any)();
        } else if (identity.user) {
          await identity.populate('user').execPopulate();
        }

        let user: IUser & Document;

        let ignoreIdentityUser = (client.preferExistingUser && existingState.user);

        if (ignoreIdentityUser) {
          let tmpValue = await ApplicationContext.triggerHookSingle<boolean>(`AuthMiddleware.auth.${provider.name}.authorize.ignoreIdentityUser`, {
            identity,
            provider,
            client,
            user,
            accessToken,
            refreshToken,
            existingState
          });
          if (typeof (tmpValue) !== 'undefined')
            ignoreIdentityUser = tmpValue;
        }
        if (!ignoreIdentityUser) {
          if (identity.user)
            await identity.populate('user').execPopulate();
        }
        if (!ignoreIdentityUser && identity.user && (identity.user as IUser & Document).username !== UNAUTHROIZED_USERNAME) {
          user = identity.user as IUser & Document;
        } else if (existingState.username === UNAUTHROIZED_USERNAME || _.isEmpty(existingState.username)) {
          if (provider.role.includes(IClientRole.registration)) {
            user = new User({
              username: identity.email || generateUsername(),
              scope: [
                ...config.get('unauthorizedScopes').slice(0)
              ],
            });
          } else {
            throw new ((global as any).ApplicationContext.errors.getErrorByName('ProviderDoesNotAllowRegistrationError') as any)();
          }
        } else {
          user = await User.findById(existingState.user).exec();
        }

        user.identities = user.identities || [];
        if (!user.identities.map(x => x.toString()).includes(identity._id))
          user.identities.push(identity._id);

        identity.user = user._id;

        await user.save();
        await identity.save();

        accessToken.user = user;
        accessToken.scope = [].concat(provider.scope);
        await accessToken.save();

        if (refreshToken) {
          refreshToken.user = user;
          refreshToken.scope = [].concat(provider.scope);
          await refreshToken.save();
          ApplicationContext.logs.silly({
            method: `AuthMiddleware.auth.${req.params.provider}.authorize.saveRefreshToken`,
            params: [
              {refreshToken: refreshToken.toObject()}
            ]
          });
        } else {
          ApplicationContext.logs.silly({
            method: `AuthMiddleware.auth.${req.params.provider}.authorize.saveRefreshToken`,
            params: [
              {refreshToken: null}
            ]
          });
        }

        req.user = user;
        existingState.user = user._id;

        let authCode = nanoid();
        stateKey = `auth.token.${authCode}`;
        let pipeline = redis.pipeline();

        for (let k in existingState) {
          pipeline.hset(stateKey, k, (existingState as any)[k].toString());
        }

        pipeline.pexpire(stateKey, config.authorizeGracePeriod);
        await pipeline.exec();

        let finalUri = URL.parse(client.redirectUri, true);
        finalUri.query = {
          ...(finalUri.query || {}),
          code: authCode,
          state: existingState.originalState
        }

        let finalUriFormatted = URL.format(finalUri);

        res.redirect(finalUriFormatted);
      }
    } else {

      if (req.query.atticAccessToken)
        req.session.atticAccessToken = req.query.atticAccessToken;
      if (req.query.response_type !== 'code') {
        throw new ((global as any).ApplicationContext.errors.getErrorByName('InvalidResponseTypeError') as any)();
      }

      let provider = await Client.findOne({
        name: req.params.provider,
        role: {$in: ['provider']}
      }).exec();

      if (!provider) {
        throw new ((global as any).ApplicationContext.errors.getErrorByName('InvalidClientOrProviderError') as any)();
      }

      let client = await Client.findOne({
        clientId: req.query.client_id,
        redirectUri: req.query.redirect_uri,
        role: {$in: ['consumer']}
      }).exec();

      if (!client) {
        throw new ((global as any).ApplicationContext.errors.getErrorByName('InvalidClientOrProviderError') as any)();
      }

      let pipeline = redis.pipeline();

      let scopes = checkScopePermission((req.query.scope || '').split(' '), client, req.user);

      let providerScopes: string[] = [];
      let unauthorizedProviderScopes: string[] = [];

      for (let scope of scopes) {
        let providerScopeMatch = scope.match(new RegExp(`^${scope}\.(.*)`));
        if (providerScopeMatch) {
          let providerScope = providerScopeMatch[1];
          if (!provider.scope.includes(providerScope))
            unauthorizedProviderScopes.push(providerScope);
          else
            providerScopes.push(providerScope);
        }
      }

      if (unauthorizedProviderScopes.length) {
        throw new NotAuthorizedToUseScopesError(unauthorizedProviderScopes);
      }

      if (!providerScopes.length)
        providerScopes = provider.scope;

      let newState = {
        client: client.id,
        provider: provider.id,
        user: req.user.id,
        originalState: originalState,
        redirectUri: '',
        username: req.user.username,
        scope: scopes.join(' ')
      };


      if (req.query.atticAccessToken)
        req.session.atticAccessToken = req.query.atticAccessToken;

      let redirectUri = URL.parse(provider.redirectUri || config.siteUri, true);
      redirectUri.path = `/auth/${provider.name}/authorize`;
      if (provider.sendStateWithRedirectUri) redirectUri.query.state = state;

      newState.redirectUri = URL.format(redirectUri);

      await ApplicationContext.triggerHookSingle(`AuthMiddleware.auth.${provider.name}.authorize.newState`, {
        req,
        provider,
        state,
        newState
      });

      for (let k in newState) {
        const v = (newState as any)[k];
        if (typeof (v) === 'undefined')
          continue;
        pipeline.hset(stateKey, k, v);
      }

      pipeline.pexpire(stateKey, config.authorizeGracePeriod);
      await pipeline.exec();

      ApplicationContext.logs.silly({
        method: `AuthMiddleware.auth.${req.params.provider}.authorize.newState`,
        params: [
          {stateKey, newState}
        ]
      });

      const delta = {
        stateKey,
        newState,
        provider,
        client,
        req,
        res,
        scopes,
        state,
        context: req.context
      };

      let authorizeEvent = `Web.AuthMiddleware.auth.${req.params.provider}.authorize.getAuthorizeRedirectUri`;
      let authorizeUri: string = await ApplicationContext.triggerHookSingle<string>(`AuthMiddleware.auth.${req.params.provider}.authorize.getAuthorizeRedirectUri`, delta);
      if (!authorizeUri)
        authorizeUri = await ApplicationContext.triggerHookSingle<string>(authorizeEvent, delta);

      let finalFormatted: any = authorizeUri;
      if (!finalFormatted) {
        let finalUri: any = URL.parse(provider.authorizeUri, true);
        let outboundScope: string[] = [];

        finalUri.query = {
          ...(finalUri.query || {}),
          client_id: provider.clientId,
          // client_secret: provider.clientSecret,
          redirect_uri: newState.redirectUri,
          state: state,
          scope: [].concat(providerScopes).join(provider.scopeJoin || config.defaultScopeJoin),
          response_type: 'code'
        };

        finalUri.query = provider.applyUriSubstitutions(finalUri.query);
        delete finalUri.search;
        finalUri.path = finalUri.path.split('?').shift();

        finalFormatted = URL.format(finalUri);
      }


      ApplicationContext.logs.silly({
        method: `AuthMiddleware.auth.${req.params.provider}.authorize.redirect`,
        params: [
          {redirectUri: finalFormatted}
        ]
      });

      res.redirect(finalFormatted);
    }
    ApplicationContext.logs.silly({
      method: `AuthMiddleware.auth.${req.params.provider}.authorize.complete`,
      params: [
        req.query
      ]
    });
  } catch (err) {
    const doNotThrow = await ApplicationContext.triggerHookSingle<boolean|undefined>('AuthMiddleware.auth.authorize.error', {
      req, res, err
    });
    if (!doNotThrow)
      throw err;
  }
}));


export const AuthMiddlewares = new Map<string, any>();


export default AuthMiddlewares;
