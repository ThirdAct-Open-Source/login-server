
import {Document, Schema} from 'mongoose';
import mongoose from './Database';
import {ObjectId} from 'mongodb';
import config from "./Config";
import {default as IUserBase } from '@znetstar/attic-common/lib/IUser';
import RPCServer from "./RPC";
import {BasicFindOptions, BasicFindQueryOptions, BasicTextSearchOptions} from "@znetstar/attic-common/lib/IRPC";
import {Chance} from 'chance';
import * as _ from 'lodash';
import IdentityEntity, {IIdentityEntityModel} from "./Entities/IdentityEntity";
import ApplicationContext from "./ApplicationContext";
import AccessToken, {AccessTokenSchema, IAccessToken, IScopeContext, toFormalToken} from "./Auth/AccessToken";
import {
  AccessTokenSet,
  AuthorizedScopePair,
  FormalAccessTokenSet,
  TokenTypes
} from "@znetstar/attic-common/lib/IAccessToken";
import {nanoid} from 'nanoid';
import Client, {SERVICE_CLIENT_ID} from "./Auth/Client";
import {
    bcryptVerify,
    bcrypt
} from 'hash-wasm';
import * as crypto from "crypto";
import {ScopeAccessTokenPair,ScopeFormalAccessTokenPair } from "@znetstar/attic-common/lib/IAccessToken";
import {CouldNotLocateUserError} from "@znetstar/attic-common/lib/Error/Auth";
import {UserHasBeenDisabledError} from "@znetstar/attic-common/lib/Error/Auth";
import {UserAlreadyExistsError} from "@znetstar/attic-common/lib/Error";

const Sentencer = require('sentencer');

interface IRegexQuery {
    $regex: string,
    $options?: string
}

export interface IUserModel {
    id: ObjectId;
    _id: ObjectId;
    scope?: (string)[];
    identities?:(IIdentityEntityModel)[];
    username: string;
    isAuthorizedToDo(scope: string|string[]): boolean;
    getAccessTokensForScope(scope: string|string[]): AsyncGenerator<ScopeAccessTokenPair>;
    getFormalAccessTokensForScope(scope: string|string[]): AsyncGenerator<ScopeFormalAccessTokenPair>;
    password?: string;
    checkPassword(password: string): Promise<boolean>;
    groups: string[];
    photo?: Buffer;
}

export type IUser = IUserBase&IUserModel;

export const UserSchema = <Schema<IUser>>(new (mongoose.Schema)({
    identities: [
        { ref: 'IdentityEntity', type: Schema.Types.ObjectId }
    ],
    scope: {
        type: [String],
        default: () =>  config.get('unauthorizedScopes').slice(0)
    },
    username: {
        type: String,
        unique: true,
        required: true
    },
    disabled: {
        type: Boolean,
        default: false
    },
    password: {
        type: String,
        required: false
    },
    groups: {
        type: [String],
        required: false,
        default: []
    },
    photo: {
      type: Buffer,
      required: false
    }
}, {
    collection: 'users',
    timestamps: true
}));

UserSchema.index({
    "$**": "text"
}, {
    name: 'user_search'
});

let chance = new Chance.Chance();
export function generateUsername() {
    return encodeURIComponent(Sentencer.make(`{{ an_adjective }}-${chance.animal()}`)
                            .toLowerCase()
                            .replace(/\s/ig, '-')
                            .replace(/^a-/, '')
                            .trim());
}

UserSchema.methods.checkPassword = async function (password: string): Promise<boolean> {
    if (!this.password)
        return false;
    return bcryptVerify({
        hash: this.password,
        password
    })
}

async function bcryptPassword(password: string): Promise<string> {
    let salt = crypto.randomBytes(16);

    const key = await bcrypt({
        password: password,
        salt,
        costFactor: 11,
        outputType: 'encoded'
    });

    return key;
}

UserSchema.pre<IUser&Document>('save', async function ()  {
    if (this.password && this.modifiedPaths().includes('password')) {
        this.password = await bcryptPassword(this.password);
    }

    if (this.groups.length) {
        for (let group of this.groups) {
            if (!this.scope.includes('group.'+group))
                this.scope.push('group.'+group);
        }
    }

    // if (this.isNew) {
    //   await ApplicationContext.createEvent<IUser>('createUser', {
    //     subject: this,
    //     description: 'A user was created'
    //   });
    // }
});

UserSchema.pre<IUser&Document>('remove', async function ()  {
  await Promise.all([
    IdentityEntity.deleteMany({ user: this._id }),
    AccessToken.deleteMany({ user: this._id })
  ]);
});


export async function* getAccessTokensForScope (user: IUser&Document|ObjectId|string, scope: string[]|string): AsyncGenerator<ScopeAccessTokenPair> {
    // @ts-ignore
    if (user instanceof ObjectId || typeof(user) === 'string' || user._bsontype === 'ObjectID' || user._bsontype === 'ObjectId')
        user = await User.findById(user).exec();

    if (!user) throw new ((global as any).ApplicationContext.errors.getErrorByName('CouldNotLocateUserError') as any)();
    else if (user.disabled) {
      throw new ((global as any).ApplicationContext.errors.getErrorByName('UserHasBeenDisabledError') as any)();
    }


  let nonImplicitScopes: string[] = [];
    scope = [].concat(scope);
    let testScope: string;
    let doneScopes = new Set();
    while (testScope = scope.shift()) {
        if (doneScopes.has(testScope)) continue;
        if (user.isAuthorizedToDo(testScope)) {
            doneScopes.add(testScope);

            let serviceClient = await Client.findOne({ clientId: SERVICE_CLIENT_ID }).exec();
            yield [testScope, new AccessToken({
                tokenType: 'bearer',
                token: ApplicationContext.makeRandomToken(),
                scope: [].concat(testScope),
                user: user,
                client: serviceClient._id,
                clientRole: 'consumer',
                clientName: serviceClient.name
            })];
        } else {
            nonImplicitScopes.push(testScope);
        }
    }

    if (!nonImplicitScopes.length) return;

    scope = nonImplicitScopes;

    let pipeline = AccessToken.aggregate();

    pipeline.match({
        user: user._id
    });

    pipeline.sort({
        isBearer: -1,
        createdAt: -1
    });

    pipeline.addFields({
        scopeQuery: [].concat(scope)
    });

    pipeline.unwind('scopeQuery');
    pipeline.unwind('scope');

    pipeline.addFields({
        scopeMatch: {
            $regexMatch: {
                input: '$scope',
                regex: '$scopeQuery',
                options: 'i'
            }
        }
    });

    pipeline.sort({
        scopeMatch: -1,
        isBearer: -1,
        createdAt: -1
    });

    pipeline.group({
        _id: {
            scopeQuery: '$scopeQuery',
            tokenType: '$tokenType',
            client: '$client'
        },
        scope: { $addToSet: '$scope' },
        doc: { $max: '$$ROOT' },
        scopeMatch: { $max: '$scopeMatch' }
    });

    pipeline.replaceRoot({
        $mergeObjects: [
            '$doc',
            '$$ROOT'
        ]
    });

    pipeline.addFields({
        _id: '$doc._id'
    })

    pipeline.project({
        doc: 0
    });

    pipeline.sort({
        scopeMatch: -1,
        isBearer: -1,
        createdAt: -1
    });

    let doc: IAccessToken&Document&{ scopeQuery: string, scopeMatch: boolean };
    let cur =  pipeline.cursor({ batchSize: 500 }).exec();

    let isDone = new Set<string>();
    while (doc = await cur.next()) {
        if (!doc)
            continue;
        if (!doc || !doc.scopeMatch) {
            yield [doc.scopeQuery, null];
        } else if (!isDone.has(JSON.stringify([doc.scopeQuery, doc.client]))) {
            isDone.add(JSON.stringify([doc.scopeQuery, doc.client]));
            if (doc.tokenType === TokenTypes.RefreshToken) {
                let child = await AccessTokenSchema.methods.accessTokenFromRefresh.call(doc);
                yield [doc.scopeQuery, child];
            } else yield [doc.scopeQuery, doc];
        }
    }
}

export function userFromRpcContext(rpcContext: any): { context: IScopeContext&{ user: IUser&Document; }, user: IUser&Document, req: any, res:any  }{
    let { req, res } = rpcContext.context.clientRequest.additionalData;

    if (!req.scopeContext || !req.scopeContext.user)
        return null;

    let scopeContext: IScopeContext = req.scopeContext;

    return {
        user: scopeContext.user as  IUser&Document,
        context: scopeContext as  IScopeContext&{ user: IUser&Document; },
        req,
        res
    }
}

export async function* getFormalAccessTokensForScope (user: IUser&Document|ObjectId|string, scope: string[]|string): AsyncGenerator<ScopeFormalAccessTokenPair> {
    for await ( let [ scopeQuery, token ] of getAccessTokensForScope(user, scope) ) {
        let formalToken = token ? await toFormalToken(token as IAccessToken&Document) : null;

        yield [ scopeQuery, formalToken ];
    }
}

RPCServer.methods.addUserToGroup = async function addUserToGroup(userId: string, group: string[]) {
  await User.updateOne({
    _id: new ObjectId(userId)
  }, {
    $addToSet: {
      'groups': { $each: [].concat(group)  }
    }
  });
}

RPCServer.methods.removeUserFromGroup = async function removeUserFromGroup(scope: string[]|string) {
    let { user } = userFromRpcContext(this);
    return RPCServer.methods.getAccessTokensForScope(user.id, scope);
}

UserSchema.methods.getAccessTokensForScope = function (scope: string[]|string) {
    return getAccessTokensForScope(this, scope);
}

RPCServer.methods.getAccessTokensForScope = async function (user: string, scope: string[]|string) {
    let result: AccessTokenSet = [];
    for await ( let pair of getAccessTokensForScope(user, scope) ) {
        if (pair && pair[1]) result.push(pair);
    }

    return result;
}

export async function deleteAccessTokens(query: any, deleteLinked: boolean = false) {
    let tokens = await AccessToken.find(query).exec();


    for (let token of tokens) {
        let toDelete = [ token ];
        if (deleteLinked) {
            toDelete.push(...(await AccessToken.find({ linkedToken: token.linkedToken }).exec()));
        }

        for (let tokenInner of toDelete)
            await tokenInner.remove();
    }
}

export async function deleteSelfAccessTokens(userId: string|ObjectId, query: any, deleteLinked: boolean = false) {
    query = query || {};
    query.user = new ObjectId(userId);

    return deleteAccessTokens(query, deleteLinked);
}

RPCServer.methods.deleteAccessTokens = async function (query: any, deleteLinked: boolean) {
    return deleteAccessTokens(query, deleteLinked);
}

RPCServer.methods.deleteSelfAccessTokens = async function (query: any, deleteLinked: boolean) {
    let { user } = userFromRpcContext(this);
    return deleteSelfAccessTokens(user._id, query, deleteLinked);
}

RPCServer.methods.getFormalAccessTokensForScope = async function (user: string, scope: string[]|string) {
    let result: FormalAccessTokenSet = [];
    for await ( let pair of getFormalAccessTokensForScope(user, scope) ) {
        if (pair && pair[1]) result.push(pair);
    }

    return result;
}

UserSchema.methods.getFormalAccessTokensForScope = function (scope: string[]|string) {
    return getFormalAccessTokensForScope(this, scope);
}


export function* authorizedScopes(scopes: string[], scope: string|string[]): Generator<AuthorizedScopePair> {
  const regexes: [ string, RegExp ][] = _.uniq(scopes).map((x: string) => {
    return [ x, new RegExp(x) ];
  });

  for (const [source, regex] of regexes) {
    const outputScopes: string[] = _.uniq([].concat(scope)).filter(testScope => regex.test(testScope));
    yield [ source, outputScopes ];
  }
}

export function isAuthorizedToDo(scopes: string[], scope: string|string[]) {
    for (const pair of authorizedScopes(scopes, scope)) {
      if (pair[1].length) return true;
    }

    return false;
}

UserSchema.methods.isAuthorizedToDo = function (scope: string[]|string) { return isAuthorizedToDo(this.scope, scope); };

RPCServer.methods.generateUsername = async () => generateUsername();

RPCServer.methods.findUser = async (query: any) => {
    let users = await User.findOne(query).exec();
    return users ? users.toJSON({ virtuals: true }) : void(0);
}

export async function findUserInner(query: BasicFindOptions) {
    let usersQuery = (User.find(query.query));
    if (query.count) {
        const count = await usersQuery.count().exec();
        return count;
    }
    if (query.sort) usersQuery.sort(query.sort);
    if (!Number.isNaN(Number(query.skip))) usersQuery.skip(query.skip);
    if (!Number.isNaN(Number(query.limit))) usersQuery.limit(query.limit);
  if (query.populate) usersQuery.populate(query.populate);
    let users = await usersQuery.exec();
    return users;
}

RPCServer.methods.findUsers = async (query: BasicFindOptions) =>  {
    let users = await findUserInner(query);
      return Array.isArray(users) ?
        users.map(l => l.toJSON({ virtuals: true })) :
        users;
}

RPCServer.methods.createUser = async (fields: any) => {
  try {
    let users = await User.create(fields);

    return users.id;
  } catch (err){
    if (err?.message && err?.message.match(/E11000 duplicate key error collection:.*index: username/)) {
      throw new UserAlreadyExistsError(`Cannot create user. The username "${fields.username}" already exists`);
    } else {
      throw err;
    }
  }
}

RPCServer.methods.deleteUsers = async (query: BasicFindQueryOptions) => {
    let users: Array<IUser & Document> = (await findUserInner(query)) as Array<IUser & Document>;
    for (let res of users) {
        await res.remove();
    }
}

RPCServer.methods.deleteUser = async (query: any) => {
    return RPCServer.methods.deleteUsers({ limit: 1, query });
}

RPCServer.methods.updateUser = async (id: string, fields: any) => {
    let doc = await User.findOne({ _id: new ObjectId(id) });

    _.extend(doc, fields);
    await doc.save();
}

RPCServer.methods.searchUsers = async (query:  BasicTextSearchOptions) => {
    let usersQuery = (User.find({
        $text: {
            $search: query.terms,
            $caseSensitive: true
        }
    }, {
        score: {
            $meta: 'textScore'
        }
    }).sort({ score:{ $meta:"textScore" }} ));
    if (query.count) {
        const count = await usersQuery.count().exec();
        return count;
    }
    if (!Number.isNaN(Number(query.skip))) usersQuery.skip(query.skip);
    if (!Number.isNaN(Number(query.limit))) usersQuery.limit(query.limit);
if (query.populate) usersQuery.populate(query.populate);
    let users = await usersQuery.exec();
    return users.map(l => l.toJSON({ virtuals: true }));
}

const User = mongoose.model<IUser&Document>('User', UserSchema);

export const UNAUTHROIZED_USERNAME = config.get('unauthorizedUserName');

ApplicationContext.once('launch.loadModels.complete', async () => {
  {
    const delta: any = {
      $setOnInsert: {
        username: UNAUTHROIZED_USERNAME,
      }
    };

    // @ts-ignore
    const groups: string[] = config.unauthorizedGroups = typeof(config.unauthorizedGroups) === 'string' ? config.unauthorizedGroups.split(",") : (config.unauthorizedGroups||[]);
    const extra: any = {
      scope: config.get('unauthorizedScopes'),
      groups: groups
    }

    if (config.allowUnauthorizedUserOverride) {
      delta.$set = extra;
    }
    else {
      delta.$setOnInsert = {
        ...delta.$setOnInsert,
        ...extra
      };
    }

    await User.updateOne({ username: UNAUTHROIZED_USERNAME }, delta, { upsert: true });
  }

  {
    if (config.rootUsername) {
      const delta: any = {
        $setOnInsert: {
          username: config.rootUsername
        }
      };

      // @ts-ignore
      const groups: string[] = config.rootGroups = typeof(config.rootGroups) === 'string' ? config.rootGroups.split(",") : (config.rootGroups||[]);

      const extra: any = {
        scope: [ '.*' ],
        groups
      }

      if (config.rootPassword) {
        extra.password = await bcryptPassword(config.rootPassword);
      }

      if (config.allowRootUserOverride) {
        delta.$set = extra;
      }
      else {
        delta.$setOnInsert = {
          ...delta.$setOnInsert,
          ...extra
        };
      }

      await User.updateOne({ username: config.rootUsername }, delta, { upsert: true });
    }
  }
});

User.collection.createIndex({
    expiresAt: 1
}, {
    expireAfterSeconds: 0
});

RPCServer.methods.getSelfUser = async function getSelfUserRpc(): Promise<IUserBase|null> {
    let { user } = userFromRpcContext(this);
    await user.populate('identities').execPopulate();

    // @ts-ignore
    return user.toJSON({ virtuals: true });
}



export default User;
