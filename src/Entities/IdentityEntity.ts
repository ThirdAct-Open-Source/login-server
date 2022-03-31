import Location, {ILocation, LocationSchema} from '../Location';
import { IEntity, default as Entity } from '../Entity';
import { Mongoose, Schema, Document } from 'mongoose';
import config from '../Config';
import mongoose from '../Database';
import { ObjectId } from 'mongodb';
import {getIdentityEntityByAccessToken, IClientModel} from "../Auth/Client";
import {IUser, IUserModel} from "../User";
import {IIdentityEntity as IIdentityEntityBase} from "@znetstar/attic-common/lib/IIdentity";
import {IHTTPResourceEntity, IHTTPResourceEntityModel} from "./HTTPResourceEntity";
import {RPCServer} from "../RPC";
import {ScopeAccessTokenPair} from "@znetstar/attic-common/lib/IAccessToken";
import {IAccessToken} from "../Auth/AccessToken";
import {CouldNotFindTokenForScopeError} from "@znetstar/attic-common/lib/Error/AccessToken";
import {NotFoundError} from "@znetstar/attic-common/lib/Error/GenericError";

export interface IIdentityEntityModel {
    _id: ObjectId;
    id: ObjectId;
    client: IClientModel;
    user: IUserModel;
    externalId: any;
    otherFields: any;
    clientName: string;
    photo?: Buffer;
}

export type IIdentityEntity = IIdentityEntityBase&IHTTPResourceEntity&IEntity;

export const IdentityEntitySchema = <Schema<IIdentityEntity>>(new (mongoose.Schema)({
    headers: {
        type: Map,
        required: false
    },
    body: {
        type: Buffer,
        required: false
    },
    method: {
        type: String,
        required: false
    },
    status: {
        type: Number,
        required: false
    },
    client: { ref: 'Client', type: Schema.Types.ObjectId },
    clientName: { type: String, required: true },
    user: { ref: 'User', type: Schema.Types.ObjectId },
    firstName: {
        type: String,
        required: false
    },
    lastName: {
        type: String,
        required: false
    },
    phone: {
        type: String,
        required: false
    },
    email: {
        type: String,
        required: false
    },
    externalId: {
        type: Schema.Types.Mixed,
        required: true
    },
    otherFields:  {
        type: Schema.Types.Mixed,
        required: false
    },
    photo: {
      type: Buffer,
      required: false
    }
}))


async function getIdentityEntity(id: ObjectId|string): Promise<IIdentityEntity&Document> {
    let entity: IIdentityEntity&Document = await IdentityEntity.findById(id).populate('client user').exec() as IIdentityEntity&Document;
    let user: IUser&Document = entity.user as IUser&Document;
    let [ scope, token ]: ScopeAccessTokenPair = (await (await user.getAccessTokensForScope(`${entity.clientName}.*`)).next()).value;
    if (!token) {
        throw new CouldNotFindTokenForScopeError([ scope, token ]);
    }

    let identity = await getIdentityEntityByAccessToken(token as IAccessToken&Document);
    return identity;
}

RPCServer.methods.getIdentityEntity = async function getIdentityEntityRpc(id: string): Promise<IIdentityEntity> {
    const entity = await getIdentityEntity(id);
    let result =  entity ? entity.toJSON({ virtuals: true }) : void(0);
    if (!result) throw new ((global as any).ApplicationContext.errors.getErrorByName('NotFoundError') as any)();
    // @ts-ignore
    result.user = result.user._id;
  // @ts-ignore
    result.client = result.client._id;

    return result as IIdentityEntity;
}

RPCServer.methods.findIdentityEntity = async function findIdentityEntityRpc(query: any): Promise<IIdentityEntity> {
    const entity = await findIdentityEntity(query);
    if (!entity) throw new ((global as any).ApplicationContext.errors.getErrorByName('NotFoundError') as any)();
    let result =  entity ? entity.toJSON({ virtuals: true }) : void(0);
    if (!result) throw new ((global as any).ApplicationContext.errors.getErrorByName('NotFoundError') as any)();

    // @ts-ignore
    result.user = result.user._id;
    // @ts-ignore
    result.client = result.client._id;

    return result as IIdentityEntity;
}

export async function findIdentityEntity  (query: any): Promise<IIdentityEntity&Document> {
    let entity = await Entity.findOne(query).exec();
    return await getIdentityEntity(entity.id);
}



export const IdentityEntity = Entity.discriminator('IdentityEntity', IdentityEntitySchema)
export default IdentityEntity;
//
// IdentityEntity.collection.createIndex({
//   externalId: 1,
//   type: 1
// }, { unique: true, name: 'externalUnique' }).catch((err) => {
//   console.error(err.stack);
//   process.exit(1);
// });
