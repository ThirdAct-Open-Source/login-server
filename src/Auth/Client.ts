import { Mongoose, Schema, Document } from 'mongoose';
import mongoose from '../Database';
import { ObjectId } from 'mongodb';
import Config from "../Config";
import IClientBase, {IClientRole} from "@znetstar/attic-common/lib/IClient";
import config from "../Config";
import {moveAndConvertValue, parseUUIDQueryMiddleware} from "../misc";
import * as _ from 'lodash';
import RPCServer from "../RPC";
import User, {IUserModel, UNAUTHROIZED_USERNAME, userFromRpcContext} from "../User";
import Location from "../Location";
import {UserSchema} from "../User";
import {IUser} from "../User";
import {IAccessToken, IFormalAccessToken} from "./AccessToken";
import {BasicFindOptions, BasicFindQueryOptions, BasicTextSearchOptions} from "@znetstar/attic-common/lib/IRPC";
import ApplicationContext from "../ApplicationContext";
import {IdentityEntity, IIdentityEntity} from "../Entities/IdentityEntity";
import { IIdentityEntity as IIdentityEntityBase } from '@znetstar/attic-common/lib/IIdentity';
import {AccessToken} from "./AccessToken";

export interface IClientModel {
    preferExistingUser?: boolean;
    id: ObjectId;
    _id: ObjectId;
    name: string;
    getIdentityEntity(token: IAccessToken&Document): Promise<IIdentityEntity&Document>;
    uriSubstitutions?: Map<string, string>;
    applyUriSubstitutions(qs: any): any;
    getdefaultUser(): IUser|string|undefined;
    defaultUsername?: string;
}

export type IClient = IClientBase&IClientModel;

export const ClientSchema = <Schema<IClient>>(new (mongoose.Schema)({
    name: { type: String, required: false, default: function () { return this.clientId;} },
    clientId: { type: String, required: true, unique: true },
    clientSecret: { type: String, required: true },
    redirectUri: { type: String, required: false },
    authorizeUri: { type: String, required: false },
    expireAccessTokenIn: { type: Number, required: false },
    expireRefreshTokenIn: { type: Number, required: false },
    tokenUri: { type: String, required: false },
    uriSubstitutions: { type: Map, required: false },
    preferExistingUser: { type: Boolean, required: false },
    refreshTokenUri: { type: String, required: false },
    scope: {
        type: [String]
    },
    role: { type: [String], required: true, enum: Object.keys(require('@znetstar/attic-common/lib/IClient').IClientRole) },
    scopeJoin: { type: String, required: false  },
    sendStateWithRedirectUri: { type: Boolean, required: false },
    defaultUsername: {
      type: String,
      required: false
    }
}, {
    collection: 'clients'
}));

ClientSchema.virtual('defaultUser', {
  justOne: true,
  ref:  'User',
  localField: 'defaultUsername',
  foreignField: 'username'
})

export function applyUriSubstitutions(provider: IClient, qs: any) {
    if (!provider.uriSubstitutions || !provider.uriSubstitutions.size)
        return qs;

    for (let [ from, to ] of provider.uriSubstitutions) {
        if (qs[from]) {
            qs[to] = qs[from];
            delete qs[from];
        }
    }

    return qs;
}

ClientSchema.methods.applyUriSubstitutions = function (qs: any): any  {
    return applyUriSubstitutions(this, qs);
}


RPCServer.methods.findClient = async (query: any) => {
    let clients = await Client.findOne(query).exec();
    return clients ? clients.toJSON({ virtuals: true }) as IClient : void(0);
}

export async function findClientInner(query: BasicFindOptions) {
    let clientsQuery = (Client.find(query.query));
    if (query.count) {
        const count = await clientsQuery.count().exec();
        return count;
    }
    if (query.sort) clientsQuery.sort(query.sort);
    if (!Number.isNaN(Number(query.skip))) clientsQuery.skip(query.skip);
    if (!Number.isNaN(Number(query.limit))) clientsQuery.limit(query.limit);
if (query.populate) clientsQuery.populate(query.populate);
    let clients = await clientsQuery.exec();
    return clients;
}

RPCServer.methods.findClients = async (query: BasicFindOptions) =>  {
    let clients = await findClientInner(query);
    return Array.isArray(clients) ?
        clients.map(l => l.toJSON({ virtuals: true })) as IClient[] :
        clients as number;
}

RPCServer.methods.createClient = async (fields: any) => {
  // @ts-ignore
    let clients: IClient&Document = await Client.create(fields);

    return clients._id;
}

RPCServer.methods.deleteClients = async (query: BasicFindQueryOptions) => {
    let clients: Array<IClient & Document> = (await findClientInner(query)) as Array<IClient & Document>;
    for (let res of clients) {
        await res.remove();
    }
}

RPCServer.methods.deleteClient = async (query: any) => {
    return RPCServer.methods.deleteClients({ limit: 1, query });
}

RPCServer.methods.updateClient = async (id: string, fields: any) => {
    let doc = await Client.findOne({ _id: new ObjectId(id) });

    _.extend(doc, fields);
    await doc.save();
}

export async function getIdentityEntityByAccessToken(accessToken: IAccessToken&Document): Promise<IIdentityEntity&Document> {
    ApplicationContext.logs.silly({
        method: `Client.getIdentityEntityByAccessToken.start`,
        params: [
            accessToken
        ]
    });
    let identity = await ApplicationContext.triggerHookSingle<IIdentityEntityBase|null>(`Client.getIdentityEntity.${accessToken.clientName}.${accessToken.clientRole}`, accessToken);
    if (!identity) {
        return null;
    }

    delete identity.id;
    delete identity._id;

    identity.clientName = accessToken.clientName;
    let existingIdentity = await IdentityEntity.findOne({
        externalId: identity.externalId,
        type: identity.type
    }).exec();

    if (existingIdentity) {
        for (let k in identity) {
            if ([ 'user' ].includes(k))
                continue;
            // @ts-ignore
            existingIdentity[k] = identity[k];
        }
    } else {
        existingIdentity = new IdentityEntity(identity);
    }

    ApplicationContext.logs.silly({
        method: `Client.getIdentityEntityByAccessToken.complete`,
        params: [
            existingIdentity
        ]
    });

    return existingIdentity as IIdentityEntity&Document;
}

async function getSelfIdentityEntityByAccessToken(user: string|ObjectId, accessTokenId: string|ObjectId): Promise<IIdentityEntity&Document> {
    let accessToken = await AccessToken.findOne({
        user: user as any,
        token: accessTokenId as any,
    }).exec();
    return getIdentityEntityByAccessToken(accessToken);
}

RPCServer.methods.getSelfIdentityEntityByAccessToken = async function(accessTokenId: string): Promise<IIdentityEntity> {
    let { user } = userFromRpcContext(this);

    return getSelfIdentityEntityByAccessToken(user._id, accessTokenId);
}


RPCServer.methods.getIdentityEntityByAccessToken = async function(accessTokenId: string): Promise<IIdentityEntity> {
    let accessToken = await AccessToken.findById(accessTokenId);
    return (await getIdentityEntityByAccessToken(accessToken)).toObject({ virtuals: true }) as IIdentityEntity;
}


// RPCServer.methods.searchClients = async (query:  BasicTextSearchOptions) => {
//     let clientsQuery = (Client.find({
//         $text: {
//             $search: query.terms,
//             $caseSensitive: true
//         }
//     }, {
//         score: {
//             $meta: 'textScore'
//         }
//     }).sort({ score:{ $meta:"textScore" }} ));
//     if (query.count) {
//         const count = await clientsQuery.count().exec();
//         return count;
//     }
//     if (!Number.isNaN(Number(query.skip))) clientsQuery.skip(query.skip);
//     if (!Number.isNaN(Number(query.limit))) clientsQuery.limit(query.limit);
// if (query.populate) clientsQuery.populate(query.populate);
//     let clients = await clientsQuery.exec();
//     return clients.map(l => l.toJSON({ virtuals: true }));
// }


const Client = mongoose.model<IClient&Document>('Client', ClientSchema);
export default Client;

// Client.collection.createIndex({
//     name: 1,
//     role: 1
// }, {
//     unique: true
// });

export const SERVICE_CLIENT_ID = config.get('serviceClientId');

ApplicationContext.once('launch.loadModels.complete', async () => {
    if (config.serviceClientId && config.serviceClientSecret) {

      const delta: any = {
        $setOnInsert: {
          clientId: config.serviceClientId
        }
      };

      // @ts-ignore
      const groups: string[] = config.rootGroups = typeof(config.rootGroups) === 'string' ? config.rootGroups.split(",") : (config.rootGroups||[]);
      const extra: any = {
        name: config.serviceClientName || config.serviceClientId,
        "clientSecret" : config.serviceClientSecret,
        "redirectUri" : config.serviceRedirectUri || config.siteUri,
        "scope" : [ '.*', ...groups.map((s) => `group.${s}`)  ],
        "role" : [
          "consumer"
        ],
        expireAccessTokenIn: null,
        expireRefreshTokenIn: null
      }

      if (config.rootUsername)
        extra.defaultUsername = config.rootUsername;

      if (config.allowClientOverride) {
        delta.$set = extra;
      }
      else {
        delta.$setOnInsert = {
          ...delta.$setOnInsert,
          ...extra
        };
      }

        await Client.updateOne({clientId: config.serviceClientId }, delta, {upsert: true});
    }
});
